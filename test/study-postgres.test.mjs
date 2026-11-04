import sharp from "sharp";
import { ChannelService } from "../dist/workspace/channel.service.js";
import { StudyLiveService } from "../dist/workspace/study-live.service.js";
import {
  defaultAttendancePolicy,
  attendanceResult,
} from "../dist/workspace/study-attendance-policy.js";
import * as Y from "yjs";
import { StudyDecksService } from "../dist/workspace/study-decks.service.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { StudyAssetsService } from "../dist/workspace/study-assets.service.js";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { WorkspaceService } from "../dist/workspace/workspace.service.js";
import { StudyService } from "../dist/workspace/study.service.js";
import { RequestsService } from "../dist/workspace/requests.service.js";
import {
  ProjectRolesService,
  resolveProjectPermissions,
} from "../dist/workspace/project-roles.service.js";
test(
  "study and development remain isolated across creation, invitations, roles, programs and sessions",
  { skip: !process.env.STUDY_PGLITE_MODULE },
  async () => {
    const { PGlite } = await import(process.env.STUDY_PGLITE_MODULE);
    const pg = new PGlite();
    const root = await mkdtemp(join(tmpdir(), "study-assets-test-"));
    const oldRoot = process.env.STUDY_ASSET_ROOT;
    process.env.STUDY_ASSET_ROOT = root;
    try {
      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      for (const e of journal.entries)
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${e.tag}.sql`, import.meta.url),
            "utf8",
          ),
        );
      const client = {
        query: async (config, params) => {
          const r = await pg.query(
            typeof config === "string" ? config : config.text,
            params,
            { rowMode: config.rowMode === "array" ? "array" : "object" },
          );
          return r;
        },
      };
      const database = { db: drizzle(client) };
      const workspace = new WorkspaceService(database),
        study = new StudyService(database),
        requests = new RequestsService(database);
      const owner = {
          id: randomUUID(),
          displayName: "운영자",
          accountType: "team",
        },
        member = { id: randomUUID(), displayName: "회원", accountType: "team" },
        outsider = {
          id: randomUUID(),
          displayName: "외부",
          accountType: "team",
        },
        customer = {
          id: randomUUID(),
          displayName: "의뢰자",
          accountType: "client",
        };
      const viewer = {
        id: randomUUID(),
        displayName: "참여자",
        accountType: "team",
      };
      for (const u of [owner, member, outsider, customer, viewer])
        await pg.query(
          "INSERT INTO users(id,email,email_normalized,display_name,account_type) VALUES($1,$2,$2,$3,$4)",
          [u.id, `${u.id}@test.invalid`, u.displayName, u.accountType],
        );
      const dev = await workspace.create(owner, {
        name: "개발",
        description: "",
        inviteeIds: [],
        repositoryUrls: [],
      });
      assert.equal(dev.kind, "development");
      const p = await workspace.create(owner, {
        kind: "study",
        name: "스터디",
        description: "",
        inviteeIds: [member.id, viewer.id],
        repositoryUrls: [],
      });
      assert.equal(p.kind, "study");
      const devRoles = new ProjectRolesService(database);
      await assert.rejects(
        devRoles.save(owner, p.id, undefined, {
          name: "개발 경로 우회",
          permissions: [],
        }),
      );
      const roles = (
        await pg.query("SELECT name FROM project_roles WHERE project_id=$1", [
          p.id,
        ])
      ).rows
        .map((r) => r.name)
        .sort();
      assert.deepEqual(roles, ["관리자", "부관리자", "회원"].sort());
      await assert.rejects(
        workspace.create(owner, {
          kind: "study",
          name: "잘못된 초대",
          inviteeIds: [customer.id],
        }),
      );
      await assert.rejects(study.snapshot(outsider, p.id));
      await assert.rejects(study.snapshot(owner, dev.id));
      await assert.rejects(requests.list(owner, p.id));
      const inv = (
        await pg.query(
          "SELECT id FROM invitations WHERE project_id=$1 AND invitee_id=$2",
          [p.id, member.id],
        )
      ).rows[0];
      await workspace.respond(member, inv.id, { action: "accept" });
      assert.equal(
        (
          await pg.query(
            "SELECT * FROM team_memberships WHERE user_id=$1 AND team_id=$2",
            [member.id, p.teamId],
          )
        ).rows.length,
        0,
        "study acceptance must not grant development team membership",
      );
      const vinv = (
        await pg.query(
          "SELECT id FROM invitations WHERE project_id=$1 AND invitee_id=$2",
          [p.id, viewer.id],
        )
      ).rows[0];
      await workspace.respond(viewer, vinv.id, { action: "accept" });
      const snap = await workspace.snapshot(member);
      assert.equal(snap.projects.length, 1);
      assert.equal(snap.projects[0].kind, "study");
      assert.equal(
        snap.projects[0].members.find((m) => m.userId === owner.id)
          .canApproveMerge,
        false,
      );
      const channel = new ChannelService(database, requests);
      const message = await channel.post(viewer, p.id, {
        body: "함께 공부해요",
      });
      assert.equal((await channel.list(viewer, p.id)).items.length, 1);
      await assert.rejects(channel.list(outsider, p.id));
      await assert.rejects(
        channel.post(viewer, p.id, {
          body: "업무 연결 금지",
          taskId: randomUUID(),
        }),
      );
      await assert.rejects(
        study.createProgram(member, p.id, { title: "권한 없음" }),
      );
      await study.setDeputy(owner, p.id, member.id, { deputy: true });
      const creationId = randomUUID();
      const draft = await study.createProgram(owner, p.id, {
        title: "생성 재시도",
        requestId: creationId,
      });
      assert.equal(
        (
          await study.createProgram(owner, p.id, {
            title: "생성 재시도",
            requestId: creationId,
          })
        ).id,
        draft.id,
      );
      await study.updateProgram(owner, p.id, draft.id, { action: "delete" });
      const program = await study.createProgram(member, p.id, {
        title: "파이썬",
        membershipMode: "all",
      });
      await study.updateProgram(member, p.id, program.id, { action: "start" });
      assert.equal(
        (await study.snapshot(member, p.id)).programs[0].memberIds.length,
        3,
      );
      await assert.rejects(
        study.updateProgram(owner, p.id, program.id, { action: "start" }),
      );
      const session = await study.saveSession(member, p.id, program.id, {
        title: "1회차",
        startsAt: "2026-12-01T05:00:00Z",
        endsAt: "2026-12-01T06:00:00Z",
      });
      await assert.rejects(
        study.saveSession(member, p.id, program.id, {
          title: "잘못된 일정",
          startsAt: "2026-12-01T06:00:00Z",
          endsAt: "2026-12-01T05:00:00Z",
        }),
      );
      const repeated = await study.saveSession(owner, p.id, program.id, {
        title: "반복",
        startsAt: "2026-12-02T05:00:00Z",
        endsAt: "2026-12-02T06:00:00Z",
        repeatEveryDays: 3,
        repeatCount: 3,
      });
      const repeatedRows = (await study.snapshot(owner, p.id)).sessions.filter(
        (s) => s.title.startsWith("반복"),
      );
      assert.equal(repeatedRows.length, 3);
      assert.equal(
        +new Date(repeatedRows[1].startsAt) -
          +new Date(repeatedRows[0].startsAt),
        3 * 86400000,
      );
      const originalSecond = repeatedRows[1];
      await study.saveSession(
        owner,
        p.id,
        program.id,
        {
          ...originalSecond,
          startsAt: "2026-12-06T05:00:00Z",
          endsAt: "2026-12-06T06:00:00Z",
        },
        originalSecond.id,
      );
      const move = {
        title: repeated.title,
        startsAt: "2026-12-02T07:00:00Z",
        endsAt: "2026-12-02T08:30:00Z",
        scope: "series",
      };
      const schedulePreview = await study.saveSession(
        owner,
        p.id,
        program.id,
        { ...move, preview: true },
        repeated.id,
      );
      assert.equal(schedulePreview.affected.length, 2);
      assert.equal(schedulePreview.protectedCount, 1);
      const moveRequest = {
        ...move,
        expectedRevision: schedulePreview.revision,
        expectedStartsAt: new Date(repeated.startsAt).toISOString(),
        expectedIds: schedulePreview.affected.map((row) => row.id),
      };
      await study.saveSession(
        owner,
        p.id,
        program.id,
        moveRequest,
        repeated.id,
      );
      await assert.rejects(
        study.saveSession(owner, p.id, program.id, moveRequest, repeated.id),
        /다시 확인/,
      );
      const moved = (await study.snapshot(owner, p.id)).sessions;
      assert.equal(
        new Date(
          moved.find((row) => row.id === originalSecond.id).startsAt,
        ).toISOString(),
        "2026-12-06T05:00:00.000Z",
      );
      assert.equal(
        new Date(
          moved.find((row) => row.id === repeatedRows[2].id).endsAt,
        ).toISOString(),
        "2026-12-08T08:30:00.000Z",
      );
      await study.saveSession(
        owner,
        p.id,
        program.id,
        { action: "cancel" },
        repeated.id,
      );
      const activity = await study.createActivity(owner, p.id, program.id, {
        title: "독서 기록",
        dueAt: "2020-01-01T00:00:00Z",
        latePolicy: "allow",
      });
      const assetService = new StudyAssetsService(database);
      const imageBytes = await sharp({
        create: {
          width: 1600,
          height: 900,
          channels: 3,
          background: "#76a2e3",
        },
      })
        .png()
        .toBuffer();
      const picture = await assetService.upload(
        member,
        p.id,
        "발표.png",
        "image/png",
        Readable.from(imageBytes),
      );
      const thumbnail = await assetService.read(
        member,
        p.id,
        picture.id,
        "thumbnail",
      );
      const thumbChunks = [];
      for await (const chunk of thumbnail.stream) thumbChunks.push(chunk);
      const thumbMeta = await sharp(Buffer.concat(thumbChunks)).metadata();
      assert.equal(thumbMeta.format, "webp");
      assert.equal(thumbMeta.width, 320);
      assert.equal(thumbMeta.height, 180);
      await assert.rejects(
        assetService.read(owner, p.id, picture.id, "thumbnail"),
      );
      const imageStorage = (
        await pg.query(
          "SELECT storage_bytes,size,thumbnail_key FROM study_assets WHERE id=$1",
          [picture.id],
        )
      ).rows[0];
      assert.ok(imageStorage.storage_bytes > imageStorage.size);
      assert.match(imageStorage.thumbnail_key, /variants\/thumbnail.webp$/);
      const asset = await assetService.upload(
        member,
        p.id,
        "독서.pdf",
        "application/pdf",
        Readable.from(Buffer.from("%PDF-1.4 test document")),
      );
      await assert.rejects(
        assetService.read(owner, p.id, asset.id, false),
        "unsubmitted private upload is not visible to owner",
      );
      await study.submit(member, p.id, activity.id, {
        body: "첨부 제출",
        assetIds: [asset.id],
      });
      const downloadable = await assetService.read(
        owner,
        p.id,
        asset.id,
        false,
      );
      downloadable.stream.destroy();
      await assert.rejects(assetService.read(outsider, p.id, asset.id, false));
      const stored = (
        await pg.query("SELECT storage_key FROM study_assets WHERE id=$1", [
          asset.id,
        ])
      ).rows[0];
      assert.match(stored.storage_key, /^\d{4}\/\d{2}\//);
      await assert.rejects(
        assetService.upload(
          member,
          p.id,
          "위장.png",
          "image/png",
          Readable.from(Buffer.from("not an image")),
        ),
      );
      const unused = await assetService.upload(
        member,
        p.id,
        "미사용.pdf",
        "application/pdf",
        Readable.from(Buffer.from("%PDF-1.4 unused")),
      );
      await pg.query(
        "UPDATE study_assets SET created_at=now()-interval '8 days',last_used_at=now()-interval '8 days' WHERE id IN ($1,$2)",
        [asset.id, unused.id],
      );
      const cleaned = await assetService.cleanupUnused();
      assert.equal(cleaned.removed, 1);
      await assert.rejects(assetService.read(member, p.id, unused.id, false));
      const kept = await assetService.read(member, p.id, asset.id, false);
      kept.stream.destroy();
      await study.submit(member, p.id, activity.id, { body: "첫 제출" });
      await study.submit(member, p.id, activity.id, { body: "수정본" });
      const detail = await study.activityDetail(member, p.id, activity.id);
      assert.equal(detail.versions.length, 3);
      assert.equal(detail.versions[1].body, "첫 제출");
      assert.equal(detail.versions[0].files[0].id, asset.id);
      const requestId = randomUUID();
      const saved = await study.submit(member, p.id, activity.id, {
        body: "재시도",
        requestId,
      });
      const retry = await study.submit(member, p.id, activity.id, {
        body: "재시도",
        requestId,
      });
      assert.equal(saved.id, retry.id);
      assert.equal(
        (await study.activityDetail(member, p.id, activity.id)).versions.length,
        4,
      );
      await study.createActivity(
        owner,
        p.id,
        program.id,
        {
          title: "독서 기록 수정",
          dueAt: "2030-01-01T00:00:00Z",
          latePolicy: "allow",
        },
        activity.id,
      );
      assert.equal(
        +new Date(
          (await study.activityDetail(member, p.id, activity.id)).versions[0]
            .deadlineAt,
        ),
        +new Date("2020-01-01T00:00:00Z"),
        "deadline edits preserve the original submission judgement",
      );
      await study.createActivity(
        owner,
        p.id,
        program.id,
        { action: "archive" },
        activity.id,
      );
      await assert.rejects(
        study.submit(member, p.id, activity.id, { body: "보관된 활동" }),
      );
      await assert.rejects(
        study.createActivity(
          owner,
          p.id,
          program.id,
          { action: "delete" },
          activity.id,
        ),
      );
      await study.createActivity(
        owner,
        p.id,
        program.id,
        { action: "restore" },
        activity.id,
      );
      const blocked = await study.createActivity(owner, p.id, program.id, {
        title: "마감",
        dueAt: "2020-01-01T00:00:00Z",
        latePolicy: "block",
      });
      await assert.rejects(
        study.submit(member, p.id, blocked.id, { body: "늦음" }),
      );
      const role = await study.saveRole(owner, p.id, {
        name: "자료 담당",
        permissions: ["study.materials.manage"],
      });
      await study.assignRoles(owner, p.id, member.id, { roleIds: [role.id] });
      assert.ok(
        (await study.snapshot(member, p.id)).permissions.includes(
          "study.materials.manage",
        ),
      );
      await assert.rejects(
        study.saveRole(member, p.id, {
          name: "권한 상승",
          permissions: ["study.roles.manage"],
        }),
      );
      await study.setDeputy(owner, p.id, member.id, { deputy: true });
      const deckService = new StudyDecksService(database);
      const deck = await deckService.create(owner, p.id, program.id, {
        title: "공동 발표",
        sessionId: session.id,
      });
      assert.equal(deck.sessionId, session.id);
      const reopened = await deckService.create(owner, p.id, program.id, { title: "중복 생성 방지", sessionId: session.id });
      assert.equal(reopened.id, deck.id);
      assert.equal((await deckService.list(owner, p.id, program.id)).decks.filter(d => d.sessionId === session.id && d.isSessionDefault).length, 1);
      assert.equal((await deckService.list(owner, p.id, program.id)).decks.find(d => d.id === deck.id).sessionId, session.id);
      await assert.rejects(deckService.create(owner, p.id, program.id, { title: "잘못된 회차", sessionId: randomUUID() }));
      const left = new Y.Doc(),
        right = new Y.Doc();
      Y.applyUpdate(left, Buffer.from(deck.state, "base64"));
      Y.applyUpdate(right, Buffer.from(deck.state, "base64"));
      const page = left.getArray("pages").get(0);
      left.getText(`body:${page}`).insert(0, "왼쪽 ");
      right.getText(`body:${page}`).insert(0, "오른쪽 ");
      await deckService.update(owner, p.id, program.id, deck.id, {
        epoch: 1,
        update: Buffer.from(Y.encodeStateAsUpdate(left)).toString("base64"),
      });
      await deckService.update(member, p.id, program.id, deck.id, {
        epoch: 1,
        update: Buffer.from(Y.encodeStateAsUpdate(right)).toString("base64"),
      });
      for (let index = 0; index < 55; index++) {
        await pg.query(
          "INSERT INTO study_deck_versions(deck_id,actor_id,state,created_at) VALUES($1,$2,$3,'2026-11-01T00:00:00Z')",
          [deck.id, owner.id, deck.state],
        );
      }
      const historyPage = await deckService.history(
        owner,
        p.id,
        program.id,
        deck.id,
      );
      assert.equal(historyPage.versions.length, 50);
      assert.ok(historyPage.nextCursor);
      const historyNext = await deckService.history(
        owner,
        p.id,
        program.id,
        deck.id,
        historyPage.nextCursor,
      );
      assert.equal(historyNext.versions.length, 7);
      assert.equal(historyNext.nextCursor, null);
      assert.equal(
        new Set(
          [...historyPage.versions, ...historyNext.versions].map((v) => v.id),
        ).size,
        57,
      );
      await assert.rejects(
        deckService.history(owner, p.id, program.id, deck.id, randomUUID()),
      );
      const merged = await deckService.get(owner, p.id, program.id, deck.id);
      Y.applyUpdate(left, Buffer.from(merged.state, "base64"));
      assert.ok(left.getText(`body:${page}`).toString().includes("왼쪽"));
      assert.ok(left.getText(`body:${page}`).toString().includes("오른쪽"));
      const privateCopy = await deckService.create(member, p.id, program.id, {
        sourceSubmissionId: detail.versions[0].id,
      });
      assert.equal(privateCopy.sourceSubmissionId, detail.versions[0].id);
      await assert.rejects(
        deckService.get(viewer, p.id, program.id, privateCopy.id),
      );
      await assert.rejects(
        deckService.configure(owner, p.id, program.id, privateCopy.id, {
          editorIds: [viewer.id],
        }),
      );
      await assert.rejects(
        assetService.read(viewer, p.id, asset.id, false),
        "copy does not make private attachments public",
      );
      assert.equal(
        (await study.activityDetail(member, p.id, activity.id)).versions.length,
        4,
        "copy preserves immutable originals",
      );
      const history = await deckService.history(
        owner,
        p.id,
        program.id,
        deck.id,
      );
      await deckService.configure(owner, p.id, program.id, deck.id, {
        restoreVersionId: history.versions[0].id,
      });
      await assert.rejects(
        deckService.update(member, p.id, program.id, deck.id, {
          epoch: 1,
          update: Buffer.from(Y.encodeStateAsUpdate(right)).toString("base64"),
        }),
      );
      await assert.rejects(
        deckService.get(outsider, p.id, program.id, deck.id),
      );
      left.destroy();
      right.destroy();
      const live = new StudyLiveService(database);
      const ownerConnection = randomUUID(),
        memberConnection = randomUUID(),
        viewerConnection = randomUUID();
      await assert.rejects(
        live.command(owner, p.id, session.id, {
          action: "start",
          connectionId: ownerConnection,
        }),
        "must configure attendance before starting",
      );
      await live.settings(owner, p.id, {
        attendance: { ...defaultAttendancePolicy, minimumMinutes: 1 },
      });
      await assert.rejects(
        live.settings(viewer, p.id, {
          attendance: { ...defaultAttendancePolicy, minimumMinutes: 1 },
        }),
      );
      let room = await live.command(owner, p.id, session.id, {
        action: "start",
        connectionId: ownerConnection,
      });
      assert.equal(room.hostId, owner.id);
      assert.equal(room.shared.deckId, deck.id);
      assert.equal(room.shared.pageId, page);
      await assert.rejects(
        study.updateProgram(owner, p.id, program.id, { action: "complete" }),
      );
      await live.command(member, p.id, session.id, {
        action: "join",
        connectionId: memberConnection,
      });
      await live.command(viewer, p.id, session.id, {
        action: "join",
        connectionId: viewerConnection,
      });
      await assert.rejects(assetService.read(viewer, p.id, asset.id, false));
      await live.command(owner, p.id, session.id, {
        action: "share",
        connectionId: ownerConnection,
        submissionId: detail.versions[0].id,
        assetId: asset.id,
      });
      const sharedAsset = await assetService.read(
        viewer,
        p.id,
        asset.id,
        false,
        "bytes=0-3",
      );
      assert.equal(sharedAsset.length, 4);
      sharedAsset.stream.destroy();
      assert.equal(
        (await live.liveSnapshot(viewer, p.id, session.id, viewerConnection))
          .shared.asset.id,
        asset.id,
      );
      await assert.rejects(
        live.liveSnapshot(outsider, p.id, session.id, viewerConnection),
      );
      await assert.rejects(
        live.command(viewer, p.id, session.id, {
          action: "presenter",
          connectionId: viewerConnection,
          userId: viewer.id,
        }),
      );
      await assert.rejects(
        live.command(owner, p.id, session.id, {
          action: "presenter",
          connectionId: ownerConnection,
          userId: outsider.id,
        }),
      );
      room = await live.command(owner, p.id, session.id, {
        action: "presenter",
        connectionId: ownerConnection,
        userId: viewer.id,
      });
      assert.equal(room.presenterId, viewer.id);
      room = await live.command(viewer, p.id, session.id, {
        action: "share",
        connectionId: viewerConnection,
        deckId: deck.id,
        pageId: page,
      });
      assert.equal(room.shared.pageId, page);
      await assert.rejects(
        assetService.read(viewer, p.id, asset.id, false),
        "shared file access ends when another material is shared",
      );
      assert.equal(
        room.shared.state,
        undefined,
        "never expose CRDT history to live viewers",
      );
      room = await live.command(owner, p.id, session.id, {
        action: "leave",
        connectionId: ownerConnection,
      });
      assert.equal(room.hostId, member.id, "connected program host takes over");
      assert.equal(
        room.presenterId,
        viewer.id,
        "takeover preserves current presenter",
      );
      room = await live.command(member, p.id, session.id, {
        action: "leave",
        connectionId: memberConnection,
      });
      assert.equal(room.waiting, true);
      await assert.rejects(
        live.command(viewer, p.id, session.id, {
          action: "join",
          connectionId: randomUUID(),
        }),
        "no new admission without host",
      );
      room = await live.command(viewer, p.id, session.id, {
        action: "heartbeat",
        connectionId: viewerConnection,
      });
      assert.equal(room.waiting, true, "existing participant remains waiting");
      const returnConnection = randomUUID();
      room = await live.command(owner, p.id, session.id, {
        action: "join",
        connectionId: returnConnection,
      });
      assert.equal(room.waiting, false);
      assert.equal(room.presenterId, viewer.id);
      room = await live.command(owner, p.id, session.id, {
        action: "reclaim",
        connectionId: returnConnection,
      });
      assert.equal(
        room.presenterId,
        viewer.id,
        "reclaiming host preserves the presenter",
      );
      await live.command(owner, p.id, session.id, {
        action: "presenter",
        connectionId: returnConnection,
        userId: owner.id,
      });
      await live.command(owner, p.id, session.id, {
        action: "end",
        connectionId: returnConnection,
      });
      const attendance = await live.attendance(viewer, p.id, session.id);
      assert.equal(attendance.ended, true);
      assert.equal(attendance.rows.length, 1);
      assert.equal(attendance.rows[0].userId, viewer.id);
      await live.correctAttendance(owner, p.id, session.id, viewer.id, {
        verdict: "present",
        reason: "연결 장애를 확인함",
      });
      assert.equal(
        (await live.attendance(viewer, p.id, session.id)).rows[0].corrections[0]
          .reason,
        "연결 장애를 확인함",
      );
      await assert.rejects(
        live.correctAttendance(member, p.id, session.id, viewer.id, {
          verdict: "present",
          reason: "권한 없음",
        }),
      );
      const policy = { ...defaultAttendancePolicy, minimumMinutes: 1 };
      const union = attendanceResult(
        policy,
        [
          [1000, 61000],
          [1000, 61000],
        ],
        [],
        0,
        90000,
        0,
      );
      assert.equal(union.seconds, 60);
      assert.equal(union.eligible, true);
      const waitExcluded = attendanceResult(
        policy,
        [[1000, 61000]],
        [[1000, 31000]],
        0,
        90000,
        0,
      );
      assert.equal(waitExcluded.seconds, 30);
      assert.equal(waitExcluded.eligible, false);
      const late = attendanceResult(
        { ...policy, mode: "deadline", graceMinutes: 0 },
        [[1000, 61000]],
        [],
        0,
        90000,
        0,
      );
      assert.equal(late.late, true);
      assert.equal(late.eligible, false);
      await study.updateProgram(owner, p.id, program.id, { action: "archive" });
      await assert.rejects(
        study.saveSession(owner, p.id, program.id, {
          title: "추가 불가",
          startsAt: session.startsAt,
          endsAt: session.endsAt,
        }),
      );
      await study.updateProgram(owner, p.id, program.id, { action: "restore" });
      await study.setDeputy(owner, p.id, member.id, { deputy: false });
      await assert.rejects(
        study.createProgram(member, p.id, { title: "회수됨" }),
      );
      await study.removeMember(viewer, p.id, viewer.id);
      await assert.rejects(study.snapshot(viewer, p.id));
      const reinvite = await workspace.invite(owner, p.id, {
        userId: viewer.id,
      });
      const pendingInvite = (
        await pg.query(
          "SELECT id FROM invitations WHERE project_id=$1 AND invitee_id=$2 AND status='pending'",
          [p.id, viewer.id],
        )
      ).rows[0];
      await workspace.respond(viewer, pendingInvite.id, { action: "accept" });
      assert.equal(
        (await study.snapshot(viewer, p.id)).programs.length,
        0,
        "rejoining space does not rejoin a started program",
      );
      await assert.rejects(
        study.submit(viewer, p.id, activity.id, {
          body: "재가입 후 참여 금지",
        }),
      );
      await assert.rejects(deckService.get(viewer, p.id, program.id, deck.id));
      await assert.rejects(study.removeMember(owner, p.id, owner.id));
      const devAccess = await database.db.transaction((tx) =>
        resolveProjectPermissions(tx, owner, dev.id),
      );
      assert.ok(devAccess.permissions.includes("requests.create"));
      assert.ok(!devAccess.permissions.some((p) => p.startsWith("study.")));
      await assert.rejects(
        workspace.update(owner, p.id, { kind: "development" }),
      );
      const pagedProgram = await study.createProgram(owner, p.id, {
        title: "목록 검증",
      });
      await study.updateProgram(owner, p.id, pagedProgram.id, {
        action: "start",
      });
      await study.saveSession(owner, p.id, pagedProgram.id, {
        title: "목록 회차",
        startsAt: "2027-01-01T05:00:00Z",
        endsAt: "2027-01-01T06:00:00Z",
        repeatCount: 52,
        repeatEveryDays: 1,
      });
      for (let i = 0; i < 53; i++)
        await study.createActivity(owner, p.id, pagedProgram.id, {
          title: `활동 ${i}`,
          dueAt: "2027-01-01T05:00:00Z",
          latePolicy: "allow",
        });
      const firstPage = await study.snapshot(owner, p.id, {
        programId: pagedProgram.id,
      });
      await assert.rejects(deckService.create(owner, p.id, pagedProgram.id, { title: "다른 프로그램 회차", sessionId: session.id }));
      assert.equal(firstPage.sessions.length, 50);
      assert.equal(firstPage.activities.length, 50);
      assert.equal(
        firstPage.sessionOptions.length,
        52,
        "older session choices remain available for activity linking",
      );
      assert.ok(firstPage.sessionOptions.every(s => s.status && s.startsAt && s.endsAt), "complete choices include card summary fields beyond the first page");
      const nextPage = await study.snapshot(owner, p.id, {
        programId: pagedProgram.id,
        sessionCursor: firstPage.pagination.sessions,
        activityCursor: firstPage.pagination.activities,
      });
      assert.equal(nextPage.sessions.length, 2);
      assert.equal(nextPage.activities.length, 3);
      assert.equal(nextPage.pagination.sessions, null);
      assert.equal(nextPage.pagination.activities, null);
      assert.equal(
        new Set(
          [...firstPage.activities, ...nextPage.activities].map((x) => x.id),
        ).size,
        53,
      );
      await assert.rejects(
        study.snapshot(owner, p.id, {
          programId: pagedProgram.id,
          sessionCursor: session.id,
        }),
      );
      await assert.rejects(
        study.snapshot(outsider, p.id, { programId: pagedProgram.id }),
      );
    } finally {
      await pg.close();
      await rm(root, { recursive: true, force: true });
      if (oldRoot === undefined) delete process.env.STUDY_ASSET_ROOT;
      else process.env.STUDY_ASSET_ROOT = oldRoot;
    }
  },
);
