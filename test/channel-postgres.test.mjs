import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { ChannelService } from "../dist/workspace/channel.service.js";
// Optional isolated PostgreSQL engine; no application DB data is touched.
test(
  "channel PostgreSQL migration, shared threads, permission isolation and stable pagination",
  { skip: !process.env.CHANNEL_PGLITE_MODULE },
  async () => {
    const { PGlite } = await import(process.env.CHANNEL_PGLITE_MODULE);
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
      const id = randomUUID(),
        team = randomUUID(),
        pid = randomUUID(),
        other = randomUUID(),
        tid = randomUUID(),
        mid = randomUUID(),
        aid = randomUUID();
      await pg.query(
        `INSERT INTO users(id,email,email_normalized,display_name,account_type) VALUES ($1,'test@channel.test','test@channel.test','채널 팀원','team')`,
        [id],
      );
      await pg.query(
        `INSERT INTO teams(id,name,created_by) VALUES ($1,'팀',$2)`,
        [team, id],
      );
      for (const p of [pid, other])
        await pg.query(
          `INSERT INTO projects(id,team_id,name,created_by) VALUES ($1,$2,'프로젝트',$3)`,
          [p, team, id],
        );
      await pg.query(
        `INSERT INTO project_tasks(id,project_id,title,created_by) VALUES ($1,$2,'디자인 업무',$3)`,
        [tid, pid, id],
      );
      await pg.query(
        `INSERT INTO project_meetings(id,project_id,title,created_by,scheduled_at,duration_minutes) VALUES ($1,$2,'회의',$3,now(),60)`,
        [mid, pid, id],
      );
      await pg.query(
        `INSERT INTO task_work_events(task_id,actor_id,action,note) VALUES ($1,$2,'completed','검토 부탁드립니다')`,
        [tid, id],
      );
      await pg.query(
        `INSERT INTO task_approvals(id,project_id,source,meeting_id,title,requested_by,plans) VALUES ($1,$2,'meeting',$3,'고객 요청 관련 승인',$4,'[]')`,
        [aid, pid, mid, id],
      );
      let permissions = ["tasks.read", "meetings.read", "requests.read"];
      let developer = true;
      const service = new ChannelService(
        {
          db: drizzle({
            query: async (config, params) => {
              const result = await pg.query(
                typeof config === "string" ? config : config.text,
                params,
              );
              return config.rowMode === "array"
                ? {
                    ...result,
                    rows: result.rows.map((row) => Object.values(row)),
                  }
                : result;
            },
          }),
        },
        { access: async () => ({ isDeveloper: developer, permissions }) },
      );
      const user = { id, displayName: "채널 팀원", accountType: "team" };
      const general = await service.post(user, pid, { body: "프로젝트 대화" });
      const task = await service.post(user, pid, {
        body: "업무 대화",
        taskId: tid,
      });
      await service.post(user, pid, {
        body: "업무 답글",
        parentKey: `message:${task.id}`,
        taskId: other,
      });
      await service.post(user, pid, {
        body: "승인 답글",
        parentKey: `approval:${aid}`,
      });
      const feed = await service.list(user, pid);
      assert.equal(feed.items.length, 4);
      const taskFeed = await service.list(user, pid, undefined, tid);
      assert.equal(taskFeed.items.length, 2);
      assert.equal(
        taskFeed.items.find((x) => x.key === `message:${task.id}`).replyCount,
        1,
      );
      const replies = await service.list(user, pid, `message:${task.id}`);
      assert.equal(replies.items[0].targetId, tid);
      assert.equal(replies.items[0].body, "업무 답글");
      await assert.rejects(
        service.post(user, other, {
          body: "cross project",
          parentKey: `message:${general.id}`,
        }),
        (e) => e.getStatus() === 404,
      );
      await assert.rejects(
        service.post(user, other, { body: "cross task", taskId: tid }),
        (e) => e.getStatus() === 404,
      );
      permissions = [];
      assert.equal((await service.list(user, pid)).items.length, 1);
      await assert.rejects(
        service.list(user, pid, `message:${task.id}`),
        (e) => e.getStatus() === 404,
      );
      await assert.rejects(
        service.post(user, pid, { body: "hidden task", taskId: tid }),
        (e) => e.getStatus() === 403,
      );
      permissions = ["meetings.read"];
      await assert.rejects(
        service.list(user, pid, `approval:${aid}`),
        (e) => e.getStatus() === 404,
      );
      permissions = ["tasks.read", "meetings.read", "requests.read"];
      await pg.query(
        `INSERT INTO channel_messages(project_id,actor_id,body,created_at) SELECT $1,$2,'page '||n,'2026-01-01T00:00:00.123456Z' FROM generate_series(1,105) n`,
        [pid, id],
      );
      const first = await service.list(user, pid);
      assert.equal(first.items.length, 100);
      assert.equal(first.hasMore, true);
      const last = first.items[0];
      const second = await service.list(
        user,
        pid,
        undefined,
        undefined,
        JSON.stringify({ at: last.cursorAt, key: last.key }),
      );
      assert.equal(second.items.length, 9);
      assert.equal(second.hasMore, false);
      assert.equal(
        new Set([...first.items, ...second.items].map((x) => x.key)).size,
        109,
      );
      developer = false;
      await assert.rejects(
        service.list(user, pid),
        (e) => e.getStatus() === 403,
      );
    } finally {
      await pg.close();
    }
  },
);
