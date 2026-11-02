import { StudyEventsService } from "./study-events.service.js";
import { studySlide } from "./study-slide.js";
import { Injectable } from "@nestjs/common";
import { and, eq, isNull, asc, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { DatabaseService } from "../db/database.service.js";
import { projects, projectMemberships as pm } from "../db/schema/workspace.js";
import { users } from "../db/schema/auth.js";
import {
  studyPrograms as programs,
  studyProgramMembers as targets,
  studyOrganizers as organizers,
  studySessions as sessions,
  studySettings as settings,
  studyLiveRooms as rooms,
  studyLiveConnections as connections,
  studyLiveWaits as waits,
  studyDecks as decks,
  studyActivities as activities,
  studySubmissionVersions as submissions,
  studySubmissionAssets as submissionAssets,
  studyAssets as assets,
  studyAttendanceCorrections as corrections,
} from "../db/schema/study.js";
import { resolveProjectPermissions } from "./project-roles.service.js";
import {
  defaultAttendancePolicy,
  attendancePolicy,
  attendanceResult,
} from "./study-attendance-policy.js";
import { uuid, bounded } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
const timeout = 15000;
@Injectable()
export class StudyLiveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: StudyEventsService = new StudyEventsService(),
  ) {}
  private async access(tx: Tx, u: User, pid: string) {
    const [p] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, uuid(pid)))
      .for("update");
    if (!p || p.kind !== "study")
      fail(404, "NOT_FOUND", "스터디를 찾을 수 없습니다.");
    return resolveProjectPermissions(tx, u, pid);
  }
  async settings(u: User, pid: string, b?: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      if (b) {
        if (!a.permissions.includes("study.settings.manage"))
          fail(403, "FORBIDDEN", "설정 권한이 필요합니다.");
        const policy = attendancePolicy(b.attendance);
        await tx
          .insert(settings)
          .values({ projectId: pid, attendance: JSON.stringify(policy) })
          .onConflictDoUpdate({
            target: settings.projectId,
            set: { attendance: JSON.stringify(policy) },
          });
      }
      const [s] = await tx
        .select()
        .from(settings)
        .where(eq(settings.projectId, pid));
      return {
        attendance: s
          ? attendancePolicy(JSON.parse(s.attendance))
          : defaultAttendancePolicy,
      };
    });
  }
  private async context(tx: Tx, u: User, pid: string, sid: string) {
    const a = await this.access(tx, u, pid);
    const [row] = await tx
      .select({ session: sessions, program: programs })
      .from(sessions)
      .innerJoin(programs, eq(programs.id, sessions.programId))
      .where(and(eq(sessions.id, uuid(sid)), eq(programs.projectId, pid)))
      .for("update");
    if (!row) fail(404, "NOT_FOUND", "회차를 찾을 수 없습니다.");
    const hosts = await tx
      .select()
      .from(organizers)
      .where(eq(organizers.programId, row.program.id));
    const [target] = await tx
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.programId, row.program.id),
          eq(targets.userId, u.id),
          isNull(targets.leftAt),
        ),
      );
    const canHost =
      hosts.some((h) => h.userId === u.id) ||
      a.permissions.includes("study.live.host");
    if (
      !target &&
      !canHost &&
      !a.permissions.some((p) =>
        [
          "study.attendance.read",
          "study.attendance.adjust",
          "study.submissions.read",
        ].includes(p),
      )
    )
      fail(403, "FORBIDDEN", "회차 참여 대상이 아닙니다.");
    return { ...row, access: a, hosts, canHost, isTarget: !!target };
  }
  async command(u: User, pid: string, sid: string, b: Record<string, unknown>) {
    const result = await this.database.db.transaction(async (tx) => {
      const c = await this.context(tx, u, pid, sid),
        now = new Date();
      if (!c.isTarget && !c.canHost)
        fail(403, "FORBIDDEN", "라이브 참여 대상이 아닙니다.");
      const action = String(b.action ?? "heartbeat");
      if (
        ![
          "start",
          "join",
          "heartbeat",
          "leave",
          "presenter",
          "reclaim",
          "share",
          "end",
        ].includes(action)
      )
        fail(400, "VALIDATION_ERROR", "라이브 동작을 확인해주세요.");
      let [room] = await tx
        .select()
        .from(rooms)
        .where(eq(rooms.sessionId, sid))
        .for("update");
      if (action === "start" && !room) {
        if (
          !c.canHost ||
          c.program.status !== "active" ||
          c.program.archivedAt ||
          c.session.status !== "scheduled"
        )
          fail(
            409,
            "STATE_CONFLICT",
            "진행 중 프로그램의 예정 회차만 운영진이 시작할 수 있습니다.",
          );
        const [s] = await tx
          .select()
          .from(settings)
          .where(eq(settings.projectId, pid));
        if (!s)
          fail(
            409,
            "ATTENDANCE_SETUP",
            "공간 설정에서 최소 참여 시간을 먼저 설정해주세요.",
          );
        const startPolicy = attendancePolicy(JSON.parse(s.attendance));
        if (
          startPolicy.minimumMinutes * 60000 >
          +c.session.endsAt - +c.session.startsAt
        )
          fail(
            409,
            "ATTENDANCE_SETUP",
            "최소 참여 시간이 예정 회차 길이보다 깁니다. 공간 설정 또는 회차 시간을 확인해주세요.",
          );
        [room] = await tx
          .insert(rooms)
          .values({
            sessionId: sid,
            startedAt: now,
            originalHostId: u.id,
            hostId: u.id,
            presenterId: u.id,
            attendance:
              s?.attendance ?? JSON.stringify(defaultAttendancePolicy),
          })
          .returning();
        await tx
          .update(sessions)
          .set({ status: "live" })
          .where(eq(sessions.id, sid));
      }
      if (!room)
        fail(409, "NOT_STARTED", "운영진이 아직 라이브를 시작하지 않았습니다.");
      if (room.endedAt) {
        if (action === "heartbeat")
          return {
            sessionId: sid,
            hostId: room.hostId,
            presenterId: room.presenterId,
            waiting: false,
            ended: true,
            canHost: c.canHost,
            canReclaim: c.canHost && room.originalHostId === u.id,
            shared: {},
            participants: [],
          };
        fail(409, "LIVE_ENDED", "종료된 라이브입니다.");
      }
      if (c.program.archivedAt || c.program.status !== "active")
        fail(
          409,
          "STATE_CONFLICT",
          "진행 중인 프로그램에서만 참여할 수 있습니다.",
        );
      const previousShared = room.shared;
      const policy = attendancePolicy(JSON.parse(room.attendance));
      const connectionId = uuid(b.connectionId);
      // A server-derived interval per browser connection; unioning avoids double credit from multiple tabs.
      let all = await tx
        .select()
        .from(connections)
        .where(eq(connections.sessionId, sid))
        .orderBy(asc(connections.joinedAt));
      const memberships = await tx
        .select({ userId: pm.userId, name: users.displayName })
        .from(pm)
        .innerJoin(users, eq(users.id, pm.userId))
        .where(eq(pm.projectId, pid));
      for (const x of all) {
        if (
          !x.leftAt &&
          (+now - +x.lastSeenAt > timeout ||
            !memberships.some((m) => m.userId === x.userId))
        ) {
          const leftAt = new Date(Math.min(+now, +x.lastSeenAt));
          await tx
            .update(connections)
            .set({ leftAt })
            .where(eq(connections.id, x.id));
          x.leftAt = leftAt;
        }
      }
      let own = all.find((x) => x.id === connectionId);
      if (own && own.userId !== u.id)
        fail(403, "FORBIDDEN", "다른 참여자의 연결입니다.");
      let active = all.filter((x) => !x.leftAt);
      // Authorizations are re-evaluated on every command so removed roles cannot retain live control.
      const ranks = new Map<string, number>();
      for (const id of new Set([...active.map((x) => x.userId), u.id])) {
        if (!memberships.some((m) => m.userId === id)) continue;
        const permission = await resolveProjectPermissions(
          tx,
          { id, accountType: "team" },
          pid,
        );
        const h = c.hosts.find((h) => h.userId === id);
        if (h) ranks.set(id, h.role === "host" ? 0 : 1);
        else if (permission.isOwner) ranks.set(id, 2);
        else if (permission.permissions.includes("study.live.host"))
          ranks.set(id, 3);
      }
      const firstJoined = new Map<string, number>();
      for (const connection of all) {
        firstJoined.set(
          connection.userId,
          Math.min(
            firstJoined.get(connection.userId) ?? Infinity,
            +connection.joinedAt,
          ),
        );
      }
      const priorHostId = room.hostId;
      const hasHost = active.some(
        (x) => x.userId === room.hostId && ranks.has(x.userId),
      );
      if (!hasHost) {
        const candidate = active
          .filter((x) => ranks.has(x.userId))
          .sort(
            (x, y) =>
              ranks.get(x.userId)! - ranks.get(y.userId)! ||
              (firstJoined.get(x.userId) ?? +x.joinedAt) -
                (firstJoined.get(y.userId) ?? +y.joinedAt) ||
              x.userId.localeCompare(y.userId),
          )[0];
        room.hostId = candidate?.userId ?? null;
      }
      let [wait] = await tx
        .select()
        .from(waits)
        .where(and(eq(waits.sessionId, sid), isNull(waits.endedAt)));
      if (!room.hostId && !wait) {
        const prior = all
          .filter((x) => x.userId === priorHostId)
          .map((x) => Math.min(+now, +x.lastSeenAt + timeout));
        [wait] = await tx
          .insert(waits)
          .values({
            sessionId: sid,
            startedAt: new Date(
              Math.max(
                +room.startedAt,
                prior.length ? Math.max(...prior) : +now,
              ),
            ),
          })
          .returning();
      }
      if (action === "join" || action === "start") {
        if (!own || own.leftAt) {
          if (own)
            fail(409, "CONNECTION_CLOSED", "새 연결로 다시 입장해주세요.");
          if (!room.hostId && !c.canHost)
            fail(409, "HOST_ABSENT", "운영진이 돌아오면 입장할 수 있습니다.");
          const deadline =
            (policy.reference === "actual"
              ? +room.startedAt
              : +c.session.startsAt) +
            policy.graceMinutes * 60000;
          if (
            !c.canHost &&
            policy.mode === "deadline" &&
            policy.lateEntry === "block" &&
            +now > deadline
          )
            fail(403, "ADMISSION_CLOSED", "입장 허용 시간이 지났습니다.");
          [own] = await tx
            .insert(connections)
            .values({
              id: connectionId,
              sessionId: sid,
              userId: u.id,
              joinedAt: now,
              lastSeenAt: now,
            })
            .returning();
          all.push(own);
          active.push(own);
        }
        if (!room.hostId && c.canHost) room.hostId = u.id;
      } else if (!own || own.leftAt) {
        fail(
          409,
          "CONNECTION_CLOSED",
          "연결이 종료되었습니다. 다시 입장해주세요.",
        );
      }
      if (own) {
        if (action === "leave") {
          own.leftAt = now;
          await tx
            .update(connections)
            .set({ leftAt: now, lastSeenAt: now })
            .where(eq(connections.id, connectionId));
          active = active.filter((x) => x.id !== connectionId);
          if (room.hostId === u.id && !active.some((x) => x.userId === u.id))
            room.hostId =
              active
                .filter((x) => ranks.has(x.userId))
                .sort(
                  (x, y) =>
                    ranks.get(x.userId)! - ranks.get(y.userId)! ||
                    (firstJoined.get(x.userId) ?? +x.joinedAt) -
                      (firstJoined.get(y.userId) ?? +y.joinedAt) ||
                    x.userId.localeCompare(y.userId),
                )[0]?.userId ?? null;
        } else {
          own.lastSeenAt = now;
          await tx
            .update(connections)
            .set({ lastSeenAt: now })
            .where(eq(connections.id, connectionId));
        }
      }
      if (action === "reclaim") {
        if (
          !c.canHost ||
          (room.hostId !== u.id && room.originalHostId !== u.id)
        )
          fail(403, "FORBIDDEN", "원래 진행자만 진행권을 되찾을 수 있습니다.");
        room.hostId = u.id;
      }
      if (action === "presenter") {
        if (room.hostId !== u.id)
          fail(403, "FORBIDDEN", "현재 진행자만 발표권을 변경할 수 있습니다.");
        const target = uuid(b.userId);
        if (!active.some((x) => x.userId === target))
          fail(
            409,
            "NOT_CONNECTED",
            "발표실에 접속한 사람만 지정할 수 있습니다.",
          );
        room.presenterId = target;
      }
      if (
        room.presenterId &&
        !active.some((x) => x.userId === room.presenterId)
      )
        room.presenterId = room.hostId;
      if (!room.presenterId && room.hostId) room.presenterId = room.hostId;
      if (action === "share") {
        if (!room.hostId || room.presenterId !== u.id)
          fail(403, "FORBIDDEN", "현재 발표자만 공유할 수 있습니다.");
        if (b.submissionId) {
          const [v] = await tx
            .select({
              id: submissions.id,
              userId: submissions.userId,
              body: submissions.body,
              bodyDocument: submissions.bodyDocument,
              title: activities.title,
              programId: activities.programId,
            })
            .from(submissions)
            .innerJoin(activities, eq(activities.id, submissions.activityId))
            .where(eq(submissions.id, uuid(b.submissionId)));
          if (!v || v.programId !== c.program.id)
            fail(404, "NOT_FOUND", "제출 자료를 찾을 수 없습니다.");
          if (
            v.userId !== u.id &&
            !c.canHost &&
            !c.access.permissions.includes("study.submissions.read")
          )
            fail(403, "FORBIDDEN", "이 제출물을 공유할 수 없습니다.");
          let asset = null;
          if (b.assetId) {
            const [f] = await tx
              .select({
                id: assets.id,
                name: assets.originalName,
                mime: assets.mime,
              })
              .from(submissionAssets)
              .innerJoin(assets, eq(assets.id, submissionAssets.assetId))
              .where(
                and(
                  eq(submissionAssets.submissionId, v.id),
                  eq(submissionAssets.assetId, uuid(b.assetId)),
                ),
              );
            if (!f) fail(404, "NOT_FOUND", "제출 첨부를 찾을 수 없습니다.");
            asset = f;
          }
          room.shared = JSON.stringify({
            type: asset ? "asset" : "submission",
            title: v.title,
            body: asset ? "" : v.body,
            bodyDocument:
              !asset && v.bodyDocument ? JSON.parse(v.bodyDocument) : null,
            asset,
            submissionId: v.id,
            sharedBy: u.id,
            sharedAt: now.toISOString(),
          });
        } else if (b.youtube) {
          let id = "";
          try {
            const link = new URL(String(b.youtube));
            if (
              link.protocol === "https:" &&
              ["youtube.com", "www.youtube.com", "youtu.be"].includes(
                link.hostname,
              )
            )
              id =
                link.hostname === "youtu.be"
                  ? link.pathname.slice(1)
                  : (link.searchParams.get("v") ?? "");
          } catch {}
          if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
            fail(400, "VALIDATION_ERROR", "YouTube 영상 링크를 확인해주세요.");
          room.shared = JSON.stringify({
            type: "youtube",
            videoId: id,
            title: "YouTube 영상",
            sharedBy: u.id,
            sharedAt: now.toISOString(),
          });
        } else if (b.assetId) {
          const [f] = await tx
            .select({
              id: assets.id,
              name: assets.originalName,
              mime: assets.mime,
              ownerId: assets.ownerId,
            })
            .from(assets)
            .where(
              and(eq(assets.id, uuid(b.assetId)), eq(assets.projectId, pid)),
            );
          if (!f || f.ownerId !== u.id)
            fail(403, "FORBIDDEN", "직접 올린 파일만 공유할 수 있습니다.");
          room.shared = JSON.stringify({
            type: "asset",
            title: f.name,
            asset: { id: f.id, name: f.name, mime: f.mime },
            sharedBy: u.id,
            sharedAt: now.toISOString(),
          });
        } else {
          const deckId = uuid(b.deckId),
            pageId = uuid(b.pageId);
          const [d] = await tx
            .select()
            .from(decks)
            .where(
              and(eq(decks.id, deckId), eq(decks.programId, c.program.id)),
            );
          if (!d) fail(404, "NOT_FOUND", "발표 자료를 찾을 수 없습니다.");
          if (d.sourceSubmissionId) {
            const [source] = await tx
              .select()
              .from(submissions)
              .where(eq(submissions.id, d.sourceSubmissionId));
            if (
              !source ||
              (source.userId !== u.id &&
                !c.hosts.some((h) => h.userId === u.id) &&
                !c.access.permissions.includes("study.submissions.read"))
            )
              fail(403, "FORBIDDEN", "원본 조회 권한이 필요합니다.");
          }
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, Buffer.from(d.state, "base64"));
            if (!doc.getArray<string>("pages").toArray().includes(pageId))
              fail(404, "NOT_FOUND", "페이지를 찾을 수 없습니다.");
            // Audience receives only the selected rendered page, never the CRDT history/deleted material.
            room.shared = JSON.stringify({
              type: "slide",
              deckId,
              pageId,
              ...studySlide(doc, pageId),
              sharedBy: u.id,
              sharedAt: now.toISOString(),
            });
          } finally {
            doc.destroy();
          }
        }
      }
      const shared = JSON.parse(room.shared);
      if (shared.type === "slide" && shared.deckId && shared.pageId) {
        const [d] = await tx
          .select()
          .from(decks)
          .where(
            and(eq(decks.id, shared.deckId), eq(decks.programId, c.program.id)),
          );
        if (d) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, Buffer.from(d.state, "base64"));
            if (
              doc.getArray<string>("pages").toArray().includes(shared.pageId)
            ) {
              Object.assign(shared, studySlide(doc, shared.pageId));
              room.shared = JSON.stringify(shared);
            } else
              room.shared = JSON.stringify({
                title: "공유 페이지가 삭제되었습니다.",
                body: "발표자가 다른 페이지를 선택할 수 있습니다.",
              });
          } finally {
            doc.destroy();
          }
        }
      }
      const rendered = JSON.parse(room.shared);
      if (rendered.type === "slide" && Array.isArray(rendered.elements)) {
        for (const element of rendered.elements) {
          if (element.assetId) {
            const [file] = await tx
              .select({ mime: assets.mime })
              .from(assets)
              .where(
                and(eq(assets.id, element.assetId), eq(assets.projectId, pid)),
              );
            element.mime = file?.mime;
          }
        }
        room.shared = JSON.stringify(rendered);
      }
      if (action === "end") {
        if (room.hostId !== u.id)
          fail(403, "FORBIDDEN", "현재 진행자만 종료할 수 있습니다.");
        room.endedAt = now;
        for (const x of active) {
          x.leftAt = now;
          await tx
            .update(connections)
            .set({ leftAt: now })
            .where(eq(connections.id, x.id));
        }
      }
      if (room.hostId || room.endedAt) {
        if (wait)
          await tx
            .update(waits)
            .set({ endedAt: now })
            .where(eq(waits.id, wait.id));
      } else if (!wait) {
        await tx.insert(waits).values({ sessionId: sid, startedAt: now });
      }
      if (previousShared !== room.shared) {
        const previous = JSON.parse(previousShared),
          current = JSON.parse(room.shared);
        const assetIds = [
          ...new Set<string>(
            [
              previous.asset?.id,
              current.asset?.id,
              ...(previous.elements ?? []).map(
                (e: { assetId?: string }) => e.assetId,
              ),
              ...(current.elements ?? []).map(
                (e: { assetId?: string }) => e.assetId,
              ),
            ].filter((id): id is string => typeof id === "string"),
          ),
        ];
        if (assetIds.length)
          await tx
            .update(assets)
            .set({ lastUsedAt: now })
            .where(
              and(eq(assets.projectId, pid), inArray(assets.id, assetIds)),
            );
      }
      await tx
        .update(rooms)
        .set({
          hostId: room.hostId,
          presenterId: room.presenterId,
          shared: room.shared,
          endedAt: room.endedAt,
        })
        .where(eq(rooms.sessionId, sid));
      if (room.endedAt)
        await tx
          .update(sessions)
          .set({ status: "ended" })
          .where(eq(sessions.id, sid));
      return {
        sessionId: sid,
        hostId: room.hostId,
        presenterId: room.presenterId,
        waiting: !room.hostId,
        ended: !!room.endedAt,
        canHost: c.canHost,
        canReclaim: c.canHost && room.originalHostId === u.id,
        shared: JSON.parse(room.shared),
        participants: memberships
          .filter((m) => active.some((x) => x.userId === m.userId))
          .map((m) => ({ ...m, canHost: ranks.has(m.userId) })),
      };
    });
    this.events.publish(pid);
    return result;
  }
  async liveSnapshot(u: User, pid: string, sid: string, connectionId: string) {
    return this.database.db.transaction(async (tx) => {
      const c = await this.context(tx, u, pid, sid);
      const [room] = await tx
        .select()
        .from(rooms)
        .where(eq(rooms.sessionId, sid));
      const [connection] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, uuid(connectionId)),
            eq(connections.sessionId, sid),
            eq(connections.userId, u.id),
          ),
        );
      if (
        !room ||
        !connection ||
        (!room.endedAt &&
          (connection.leftAt || Date.now() - +connection.lastSeenAt > timeout))
      )
        fail(403, "CONNECTION_CLOSED", "발표실에 다시 입장해주세요.");
      const list = await tx
        .select({
          userId: connections.userId,
          name: users.displayName,
          lastSeen: connections.lastSeenAt,
          leftAt: connections.leftAt,
        })
        .from(connections)
        .innerJoin(users, eq(users.id, connections.userId))
        .innerJoin(
          pm,
          and(eq(pm.userId, connections.userId), eq(pm.projectId, pid)),
        )
        .where(eq(connections.sessionId, sid));
      const participants = [
        ...new Map(
          list
            .filter((x) => !x.leftAt && Date.now() - +x.lastSeen <= timeout)
            .map((x) => [
              x.userId,
              {
                userId: x.userId,
                name: x.name,
                canHost: c.hosts.some((h) => h.userId === x.userId),
              },
            ]),
        ).values(),
      ];
      const shared = JSON.parse(room.shared);
      if (shared.type === "slide") {
        const [d] = await tx
          .select()
          .from(decks)
          .where(
            and(eq(decks.id, shared.deckId), eq(decks.programId, c.program.id)),
          );
        if (d) {
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, Buffer.from(d.state, "base64"));
            if (
              doc.getArray<string>("pages").toArray().includes(shared.pageId)
            ) {
              Object.assign(shared, studySlide(doc, shared.pageId));
              for (const element of shared.elements) {
                if (element.assetId) {
                  const [file] = await tx
                    .select({ mime: assets.mime })
                    .from(assets)
                    .where(
                      and(
                        eq(assets.id, element.assetId),
                        eq(assets.projectId, pid),
                      ),
                    );
                  element.mime = file?.mime;
                }
              }
            } else {
              shared.title = "공유 페이지가 삭제되었습니다.";
              shared.body = "다른 페이지를 선택해주세요.";
              shared.elements = [];
            }
          } finally {
            doc.destroy();
          }
        }
      }
      return {
        sessionId: sid,
        hostId: room.hostId,
        presenterId: room.presenterId,
        waiting: !room.hostId,
        ended: !!room.endedAt,
        canHost: c.canHost,
        canReclaim: c.canHost && room.originalHostId === u.id,
        shared: room.endedAt ? {} : shared,
        participants: room.endedAt ? [] : participants,
      };
    });
  }
  async materials(u: User, pid: string, sid: string, filterSession?: string) {
    return this.database.db.transaction(async (tx) => {
      const c = await this.context(tx, u, pid, sid);
      const acts = await tx
        .select()
        .from(activities)
        .where(eq(activities.programId, c.program.id));
      const requested = filterSession ? uuid(filterSession) : sid;
      const relevant = acts.filter(
        (a) =>
          a.sessionId === requested ||
          ((!filterSession || requested === sid) && !a.sessionId),
      );
      const result = [];
      for (const a of relevant) {
        const submitted = await tx
          .select({
            id: submissions.id,
            userId: submissions.userId,
            body: submissions.body,
            bodyDocument: submissions.bodyDocument,
            submittedAt: submissions.submittedAt,
            name: users.displayName,
          })
          .from(submissions)
          .innerJoin(users, eq(users.id, submissions.userId))
          .where(eq(submissions.activityId, a.id))
          .orderBy(asc(submissions.submittedAt));
        const latest = new Map<string, (typeof submitted)[number]>();
        for (const v of submitted) latest.set(v.userId, v);
        for (const v of latest.values()) {
          if (
            v.userId !== u.id &&
            !c.canHost &&
            !c.access.permissions.includes("study.submissions.read")
          )
            continue;
          const files = await tx
            .select({
              id: assets.id,
              name: assets.originalName,
              mime: assets.mime,
            })
            .from(submissionAssets)
            .innerJoin(assets, eq(assets.id, submissionAssets.assetId))
            .where(eq(submissionAssets.submissionId, v.id));
          result.push({
            ...v,
            bodyDocument: v.bodyDocument ? JSON.parse(v.bodyDocument) : null,
            title: a.title,
            sessionId: a.sessionId,
            files,
          });
        }
      }
      const choices = await tx
        .select({ id: sessions.id, title: sessions.title })
        .from(sessions)
        .where(eq(sessions.programId, c.program.id))
        .orderBy(asc(sessions.startsAt));
      return { submissions: result, sessions: choices };
    });
  }
  async correctAttendance(
    u: User,
    pid: string,
    sid: string,
    targetId: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const c = await this.context(tx, u, pid, sid);
      if (!c.access.permissions.includes("study.attendance.adjust"))
        fail(403, "FORBIDDEN", "출석 보정 권한이 필요합니다.");
      const [room] = await tx
        .select()
        .from(rooms)
        .where(eq(rooms.sessionId, sid));
      if (!room?.endedAt)
        fail(409, "STATE_CONFLICT", "라이브 종료 후 보정할 수 있습니다.");
      const [target] = await tx
        .select()
        .from(targets)
        .where(
          and(
            eq(targets.programId, c.program.id),
            eq(targets.userId, uuid(targetId)),
          ),
        );
      if (!target) fail(404, "NOT_FOUND", "출석 대상자가 아닙니다.");
      if (!["present", "absent", "automatic"].includes(String(b.verdict)))
        fail(400, "VALIDATION_ERROR", "출석 판정을 확인해주세요.");
      return (
        await tx
          .insert(corrections)
          .values({
            sessionId: sid,
            userId: targetId,
            actorId: u.id,
            verdict: String(b.verdict),
            reason: bounded(b.reason, 1000),
          })
          .returning()
      )[0];
    });
  }
  async attendance(u: User, pid: string, sid: string) {
    return this.database.db.transaction(async (tx) => {
      const c = await this.context(tx, u, pid, sid);
      const [room] = await tx
        .select()
        .from(rooms)
        .where(eq(rooms.sessionId, sid));
      if (!room) return { rows: [], ended: false };
      const list = await tx
        .select()
        .from(connections)
        .where(eq(connections.sessionId, sid));
      const waiting = await tx
        .select()
        .from(waits)
        .where(eq(waits.sessionId, sid));
      const cutoff = +(room.endedAt ?? new Date());
      const changes = await tx
        .select({
          id: corrections.id,
          userId: corrections.userId,
          actorId: corrections.actorId,
          verdict: corrections.verdict,
          reason: corrections.reason,
          createdAt: corrections.createdAt,
          actorName: users.displayName,
        })
        .from(corrections)
        .innerJoin(users, eq(users.id, corrections.actorId))
        .where(eq(corrections.sessionId, sid))
        .orderBy(asc(corrections.createdAt));
      const all = await tx
        .select({ userId: targets.userId, name: users.displayName })
        .from(targets)
        .innerJoin(users, eq(users.id, targets.userId))
        .where(eq(targets.programId, c.program.id));
      const visible =
        c.canHost ||
        c.access.permissions.some((p) =>
          ["study.attendance.read", "study.attendance.adjust"].includes(p),
        )
          ? all
          : all.filter((m) => m.userId === u.id);
      return {
        ended: !!room.endedAt,
        canAdjust: c.access.permissions.includes("study.attendance.adjust"),
        policy: JSON.parse(room.attendance),
        rows: visible.map((m) => {
          const entries = list.filter((x) => x.userId === m.userId);
          return {
            ...m,
            corrections: changes.filter((v) => v.userId === m.userId),
            ...attendanceResult(
              attendancePolicy(JSON.parse(room.attendance)),
              entries.map((x) => [
                +x.joinedAt,
                Math.min(cutoff, +(x.leftAt ?? new Date(+x.lastSeenAt))),
              ]),
              waiting.map((x) => [
                +x.startedAt,
                Math.min(cutoff, +(x.endedAt ?? new Date(cutoff))),
              ]),
              +c.session.startsAt,
              +c.session.endsAt,
              +room.startedAt,
            ),
            entries: entries.map((x) => ({
              joinedAt: x.joinedAt,
              leftAt: x.leftAt ?? new Date(Math.min(cutoff, +x.lastSeenAt)),
            })),
          };
        }),
      };
    });
  }
}
