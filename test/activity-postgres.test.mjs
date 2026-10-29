import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { RequestsService } from "../dist/workspace/requests.service.js";
import { ProjectWorkService } from "../dist/workspace/project-work.service.js";
import { ActivityService } from "../dist/workspace/activity.service.js";
import { StagedWorkService } from "../dist/workspace/staged-work.service.js";
import { recordTaskActivity } from "../dist/workspace/activity-record.js";
test(
  "activity: migrations, lifecycle, snapshots, filtering, permissions, pagination and staged work",
  { skip: !process.env.ACTIVITY_PGLITE_MODULE },
  async () => {
    const { PGlite } = await import(process.env.ACTIVITY_PGLITE_MODULE);
    const pg = new PGlite();
    try {
      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      for (const entry of journal.entries)
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
            "utf8",
          ),
        );
      const client = {
        query: async (config, params) => {
          const r = await pg.query(
            typeof config === "string" ? config : config.text,
            params,
          );
          return config.rowMode === "array"
            ? { ...r, rows: r.rows.map((row) => Object.values(row)) }
            : r;
        },
      };
      const db = { db: drizzle(client) };
      const requests = new RequestsService(db),
        work = new ProjectWorkService(db, requests),
        activity = new ActivityService(db, requests),
        staged = new StagedWorkService(db, requests);
      const owner = {
          id: randomUUID(),
          displayName: "관리자",
          accountType: "team",
        },
        worker = {
          id: randomUUID(),
          displayName: "담당자",
          accountType: "team",
        },
        outsider = {
          id: randomUUID(),
          displayName: "외부",
          accountType: "team",
        };
      const team = randomUUID(),
        pid = randomUUID(),
        pid2 = randomUUID();
      for (const u of [owner, worker, outsider])
        await pg.query(
          "insert into users(id,email,email_normalized,display_name,account_type) values($1,$2,$2,$3,'team')",
          [u.id, `${u.id}@test.invalid`, u.displayName],
        );
      await pg.query("insert into teams(id,name,created_by) values($1,$2,$3)", [
        team,
        "검증 팀",
        owner.id,
      ]);
      for (const [u, role] of [
        [owner, "owner"],
        [worker, "member"],
      ])
        await pg.query(
          "insert into team_memberships(team_id,user_id,permission_role) values($1,$2,$3)",
          [team, u.id, role],
        );
      for (const id of [pid, pid2]) {
        await pg.query(
          "insert into projects(id,team_id,name,created_by) values($1,$2,$3,$4)",
          [id, team, "프로젝트", owner.id],
        );
        await pg.query(
          "insert into project_memberships(project_id,user_id,access_role) values($1,$2,'manager')",
          [id, owner.id],
        );
      }
      await pg.query(
        "insert into project_memberships(project_id,user_id,access_role) values($1,$2,'contributor')",
        [pid, worker.id],
      );
      const create = async (title, p = pid) =>
        (
          await requests.create(owner, p, {
            title,
            description: "설명",
            priority: "normal",
            type: "feature",
          })
        ).request;
      const r1 = await create("로그인"),
        r2 = await create("주문"),
        r3 = await create("브랜드", pid2);
      assert.equal((await activity.list(owner, {})).events.length, 3);
      const meeting = (
        await work.saveMeeting(owner, pid, {
          title: "개선 회의",
          scheduledAt: "2026-10-30T02:00:00Z",
          requests: [{ requestId: r1.id }, { requestId: r2.id }],
        })
      ).meeting;
      let feed = (await activity.list(owner, { category: "meeting" })).events;
      assert.equal(feed.length, 1);
      assert.equal(feed[0].requests.length, 2);
      const scheduledId = feed[0].id;
      await work.saveMeeting(owner, pid, { notes: "메모 수정" }, meeting.id);
      assert.equal(
        (await activity.list(owner, { category: "meeting" })).events.length,
        1,
      );
      await assert.rejects(
        work.saveMeeting(owner, pid, { status: "completed" }, meeting.id),
        (e) => e.getStatus() === 409,
      );
      await assert.rejects(
        work.meetingAction(owner, pid, meeting.id, { action: "complete" }),
        (e) => e.getStatus() === 409,
      );
      const started = await work.meetingAction(owner, pid, meeting.id, {
        action: "start",
      });
      assert.equal(started.meeting.status, "in_progress");
      assert.ok(started.meeting.startedAt);
      await work.meetingAction(owner, pid, meeting.id, { action: "start" });
      const done = await work.meetingAction(owner, pid, meeting.id, {
        action: "complete",
      });
      assert.ok(done.meeting.endedAt);
      await work.meetingAction(owner, pid, meeting.id, { action: "complete" });
      assert.equal(
        (await activity.list(owner, { category: "meeting" })).events.length,
        3,
      );
      assert.equal(
        (await activity.list(owner, { requestId: r1.id, order: "asc" })).events
          .length,
        4,
      );
      await work.saveMeeting(
        owner,
        pid,
        { requests: [{ requestId: r1.id }] },
        meeting.id,
      );
      const detail = await activity.detail(owner, scheduledId);
      assert.equal(
        detail.requests.length,
        2,
        "historical removed request remains linked to original event",
      );
      assert.ok(
        (await activity.list(owner, { requestId: r2.id })).events.some(
          (e) => e.kind === "request_unlinked",
        ),
      );
      assert.equal(
        (await activity.list(owner, { projectIds: pid2 })).events.length,
        1,
      );
      assert.equal((await activity.list(outsider, {})).events.length, 0);
      await assert.rejects(activity.detail(outsider, scheduledId));
      const task = randomUUID();
      await pg.query(
        "insert into project_tasks(id,project_id,title,created_by,stage_key,completion_mode,status,result_summary,verification) values($1,$2,'로그인 QA',$3,'qa','test','in_progress','테스트 결과','확인')",
        [task, pid, owner.id],
      );
      await pg.query(
        "insert into task_requests(task_id,request_id) values($1,$2)",
        [task, r1.id],
      );
      await pg.query(
        "insert into task_assignees(task_id,user_id) values($1,$2)",
        [task, worker.id],
      );
      await pg.query(
        "insert into task_work_reviewers(task_id,user_id) values($1,$2)",
        [task, owner.id],
      );
      await db.db.transaction((tx) =>
        recordTaskActivity(
          tx,
          task,
          owner.id,
          "task_assigned",
          "",
          `assigned:${task}`,
        ),
      );
      await staged.act(worker, pid, task, {
        action: "complete",
        expectedRevision: 1,
      });
      await staged.act(owner, pid, task, {
        action: "approve",
        expectedRevision: 1,
      });
      const kinds = (
        await activity.list(owner, { requestId: r1.id })
      ).events.map((e) => e.kind);
      assert.ok(kinds.includes("qa_completed"));
      assert.ok(kinds.includes("task_approved"));
      assert.ok(kinds.includes("task_review_requested"));
      const assigned = (await activity.list(owner, { assigneeId: worker.id }))
        .events;
      assert.ok(assigned.some((e) => e.kind === "request_created"));
      assert.ok(assigned.some((e) => e.kind === "meeting_started"));
      assert.ok(!assigned.some((e) => e.requests.some((r) => r.id === r3.id)));
      // Role changes must revoke metadata, historical records and detail access consistently.
      const role = randomUUID();
      await pg.query(
        "insert into project_roles(id,project_id,name,permissions) values($1,$2,'기록만',ARRAY['activity.read'])",
        [role, pid],
      );
      await pg.query(
        "insert into project_member_roles(project_id,user_id,role_id) values($1,$2,$3)",
        [pid, worker.id, role],
      );
      await pg.query(
        "update project_memberships set roles_configured=true where project_id=$1 and user_id=$2",
        [pid, worker.id],
      );
      assert.equal((await activity.list(worker, {})).events.length, 0);
      assert.equal((await activity.options(worker, {})).requests.length, 0);
      await assert.rejects(activity.detail(worker, scheduledId));
      // Equal timestamp pages must not skip records at the cursor boundary.
      for (let i = 0; i < 65; i++)
        await pg.query(
          "insert into activity_events(project_id,kind,category,title,actor_name,source_key,occurred_at) values($1,'task_started','task','경계','시스템',$2,'2030-01-01T00:00:00.123Z')",
          [pid, `page:${i}`],
        );
      const seen = new Set();
      let cursor;
      do {
        const p = await activity.list(owner, {
          category: "task",
          ...(cursor ? { cursor } : {}),
        });
        for (const e of p.events) {
          assert.ok(!seen.has(e.id));
          seen.add(e.id);
        }
        cursor = p.nextCursor;
      } while (cursor);
      assert.ok(seen.size >= 68);
      console.log("Verified actual SQL lifecycle and event queries.");
    } finally {
      await pg.close();
    }
  },
);
