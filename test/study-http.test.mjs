import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Y from "yjs";
import { AuthService } from "../dist/auth/auth.service.js";
import { digest } from "../dist/auth/security.js";
import { WorkspaceService } from "../dist/workspace/workspace.service.js";
import { WorkspaceController } from "../dist/workspace/workspace.controller.js";
import { StudyController } from "../dist/workspace/study.controller.js";
import { StudyService } from "../dist/workspace/study.service.js";
import { StudyAssetsService } from "../dist/workspace/study-assets.service.js";
import { StudyDecksService } from "../dist/workspace/study-decks.service.js";
import { StudyLiveService } from "../dist/workspace/study-live.service.js";
import { StudyEventsService } from "../dist/workspace/study-events.service.js";
import { defaultAttendancePolicy } from "../dist/workspace/study-attendance-policy.js";

test(
  "authenticated HTTP: 20 viewers, 5 editors, SSE, presenter revocation and reconnect",
  {
    skip:
      !process.env.STUDY_HTTP_TEST ||
      (!process.env.STUDY_PGLITE_MODULE && !process.env.STUDY_POSTGRES_URL),
    timeout: 90000,
  },
  async () => {
    const postgres = process.env.STUDY_POSTGRES_URL
      ? new Pool({ connectionString: process.env.STUDY_POSTGRES_URL, max: 10 })
      : null;
    const pg = postgres
      ? {
          query: (...args) => postgres.query(...args),
          exec: (sql) => postgres.query(sql),
          close: () => postgres.end(),
        }
      : new (await import(process.env.STUDY_PGLITE_MODULE)).PGlite();
    if (postgres) {
      const existing = await postgres.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='public' LIMIT 1",
      );
      if (existing.rows.length) {
        await postgres.end();
        throw Error(
          "HTTP test requires a completely empty disposable database",
        );
      }
    }
    const root = await mkdtemp(join(tmpdir(), "study-http-"));
    const old = {
      secret: process.env.AUTH_PROXY_SECRET,
      root: process.env.STUDY_ASSET_ROOT,
      origin: process.env.DEVELOPER_APP_ORIGIN,
    };
    process.env.AUTH_PROXY_SECRET = randomBytes(32).toString("hex");
    process.env.STUDY_ASSET_ROOT = root;
    process.env.DEVELOPER_APP_ORIGIN = "http://localhost:15184";
    let app;
    const streams = [];
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
      // PGlite has one connection. Serialize transactions and standalone queries;
      // HTTP requests remain concurrent, but this is not a real PostgreSQL load benchmark.
      let tail = Promise.resolve();
      async function acquire() {
        let release;
        const next = new Promise((r) => (release = r));
        const prior = tail;
        tail = next;
        await prior;
        return release;
      }
      const query = (config, params) =>
        pg.query(typeof config === "string" ? config : config.text, params, {
          rowMode: config.rowMode === "array" ? "array" : "object",
        });
      class TestPool {
        async connect() {
          const release = await acquire();
          return { query, release };
        }
        async query(config, params) {
          const release = await acquire();
          try {
            return await query(config, params);
          } finally {
            release();
          }
        }
      }
      const database = { db: drizzle(postgres ?? new TestPool()) };
      const workspace = new WorkspaceService(database),
        study = new StudyService(database),
        events = new StudyEventsService();
      const decks = new StudyDecksService(database, events),
        live = new StudyLiveService(database, events),
        assets = new StudyAssetsService(database);
      const auth = new WorkspaceController(
        new AuthService(database),
        workspace,
      );
      class TestModule {}
      Module({
        controllers: [StudyController],
        providers: [
          [WorkspaceController, auth],
          [StudyService, study],
          [StudyAssetsService, assets],
          [StudyDecksService, decks],
          [StudyLiveService, live],
          [StudyEventsService, events],
        ].map(([provide, useValue]) => ({ provide, useValue })),
      })(TestModule);
      app = await NestFactory.create(TestModule, { logger: false });
      app.setGlobalPrefix("api");
      await app.listen(0, "127.0.0.1");
      const origin = await app.getUrl();
      const users = [];
      for (let i = 0; i < 21; i++) {
        const user = {
          id: randomUUID(),
          accountType: "team",
          displayName: `회원 ${i}`,
          token: randomBytes(32).toString("hex"),
          connectionId: randomUUID(),
        };
        await pg.query(
          "INSERT INTO users(id,email,email_normalized,display_name,account_type) VALUES($1,$2,$2,$3,'team')",
          [user.id, `${user.id}@example.invalid`, user.displayName],
        );
        await pg.query(
          "INSERT INTO auth_sessions(user_id,token_hash,app_kind,expires_at) VALUES($1,$2,'developer',now()+interval '1 hour')",
          [user.id, digest(user.token)],
        );
        users.push(user);
      }
      const owner = users[0];
      const project = await workspace.create(owner, {
        kind: "study",
        name: "HTTP 검증",
        inviteeIds: users.slice(1).map((u) => u.id),
      });
      for (const user of users.slice(1)) {
        const inv = (
          await pg.query(
            "SELECT id FROM invitations WHERE project_id=$1 AND invitee_id=$2",
            [project.id, user.id],
          )
        ).rows[0];
        await workspace.respond(user, inv.id, { action: "accept" });
      }
      const program = await study.createProgram(owner, project.id, {
        title: "동시 접속 검증",
      });
      await study.updateProgram(owner, project.id, program.id, {
        action: "start",
      });
      const session = await study.saveSession(owner, project.id, program.id, {
        title: "발표",
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
      });
      await live.settings(owner, project.id, {
        attendance: { ...defaultAttendancePolicy, minimumMinutes: 1 },
      });
      const base = `/api/workspace/projects/${project.id}/study`,
        livePath = `${base}/sessions/${session.id}/live`;
      const csrf = "a".repeat(64);
      function headers(user) {
        return {
          "x-bridgain-app": "developer",
          "x-bridgain-proxy-secret": process.env.AUTH_PROXY_SECRET,
          origin: process.env.DEVELOPER_APP_ORIGIN,
          "x-csrf-token": csrf,
          cookie: `bridgain_developer_session=${user.token}; bridgain_developer_csrf=${csrf}`,
          "content-type": "application/json",
        };
      }
      async function call(user, path, body, method = "POST", expected = 200) {
        const response = await fetch(origin + path, {
          method,
          headers: headers(user),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await response.json();
        assert.equal(response.status, expected, JSON.stringify(data));
        return data;
      }
      // Nest POST defaults to 201.
      const command = (user, body, expected = 201) =>
        call(
          user,
          livePath,
          { connectionId: user.connectionId, ...body },
          "POST",
          expected,
        );
      await command(owner, { action: "start" });
      const started = performance.now();
      await Promise.all(
        users.slice(1).map((user) => command(user, { action: "join" })),
      );
      const snapshot = await command(owner, { action: "heartbeat" });
      assert.equal(snapshot.participants.length, 21);
      const sseAbort = new AbortController();
      streams.push(sseAbort);
      const response = await fetch(
        `${origin}${base}/sessions/${session.id}/events?connectionId=${users[1].connectionId}`,
        {
          headers: headers(users[1]),
          signal: AbortSignal.any([
            sseAbort.signal,
            AbortSignal.timeout(30000),
          ]),
        },
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const otherStreams = await Promise.all(
        users.slice(2).map(async (user) => {
          const abort = new AbortController();
          streams.push(abort);
          const reply = await fetch(
            `${origin}${base}/sessions/${session.id}/events?connectionId=${user.connectionId}`,
            {
              headers: headers(user),
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(30000),
              ]),
            },
          );
          assert.equal(reply.status, 200);
          const reader = reply.body.getReader();
          const first = await reader.read();
          assert.ok(
            !first.done &&
              new TextDecoder().decode(first.value).includes("data:"),
          );
          return reader;
        }),
      );
      // Consume real network streams during editor writes; don't just count registrations.
      const draining = otherStreams.map(async (reader) => {
        try {
          while (!(await reader.read()).done) {}
        } catch (error) {
          if (error.name !== "AbortError" && error.name !== "TimeoutError")
            throw error;
        }
      });
      const reader = response.body.getReader();
      let buffer = "";
      async function eventWhere(predicate) {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          let cut;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const line = chunk.split("\n").find((s) => s.startsWith("data: "));
            if (line) {
              const data = JSON.parse(line.slice(6));
              if (predicate(data)) return data;
            }
          }
          const item = await reader.read();
          if (item.done) throw Error("SSE closed unexpectedly");
          buffer += new TextDecoder().decode(item.value);
        }
        throw Error("SSE update timed out");
      }
      await eventWhere((data) => data.hostId === owner.id);
      await command(owner, { action: "presenter", userId: users[1].id });
      await eventWhere((data) => data.presenterId === users[1].id);
      await command(owner, { action: "presenter", userId: owner.id });
      await eventWhere((data) => data.presenterId === owner.id);
      await command(
        users[1],
        {
          action: "share",
          youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
        403,
      );
      const deck = await call(
        owner,
        `${base}/programs/${program.id}/decks`,
        { title: "5인 편집" },
        "POST",
        201,
      );
      await call(
        owner,
        `${base}/programs/${program.id}/decks/${deck.id}/configure`,
        { editorIds: users.slice(1, 6).map((u) => u.id) },
        "POST",
        201,
      );
      const pageId = new Y.Doc();
      Y.applyUpdate(pageId, Buffer.from(deck.state, "base64"));
      const slide = pageId.getArray("pages").get(0);
      await Promise.all(
        users.slice(1, 6).map(async (user, index) => {
          const doc = new Y.Doc();
          Y.applyUpdate(doc, Buffer.from(deck.state, "base64"));
          doc.getText(`body:${slide}`).insert(0, `편집자${index} `);
          await call(
            user,
            `${base}/programs/${program.id}/decks/${deck.id}`,
            {
              epoch: deck.epoch,
              update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString(
                "base64",
              ),
            },
            "PATCH",
          );
          doc.destroy();
        }),
      );
      const merged = await call(
        owner,
        `${base}/programs/${program.id}/decks/${deck.id}`,
        undefined,
        "GET",
      );
      Y.applyUpdate(pageId, Buffer.from(merged.state, "base64"));
      for (let i = 0; i < 5; i++)
        assert.ok(
          pageId.getText(`body:${slide}`).toString().includes(`편집자${i}`),
        );
      pageId.destroy();
      await command(users[2], { action: "leave" });
      users[2].connectionId = randomUUID();
      await command(users[2], { action: "join" });
      const invalid = await fetch(origin + base, {
        headers: { ...headers(owner), cookie: "" },
      });
      assert.equal(invalid.status, 401);
      const invalidCsrf = await fetch(origin + livePath, {
        method: "POST",
        headers: { ...headers(owner), "x-csrf-token": "invalid" },
        body: JSON.stringify({
          action: "heartbeat",
          connectionId: owner.connectionId,
        }),
      });
      assert.equal(invalidCsrf.status, 403);
      // An already-open stream must stop when its login session is revoked.
      await database.db.execute(
        (await import("drizzle-orm"))
          .sql`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${users[1].id}`,
      );
      events.publish(project.id);
      let closed = buffer.includes("event: closed");
      while (!closed) {
        const item = await reader.read();
        if (item.done) break;
        buffer += new TextDecoder().decode(item.value);
        closed = buffer.includes("event: closed");
      }
      assert.ok(closed, "revoked authentication must terminate SSE");
      sseAbort.abort();
      await command(owner, { action: "end" });
      for (const stream of streams) stream.abort();
      await Promise.all(draining);
      console.log(
        `HTTP integration: 21 participants, 20 SSE connections, 5 editors and reconnect passed in ${Math.round(performance.now() - started)}ms ${postgres ? "isolated PostgreSQL, 10-connection pool" : "serialized PGlite; not production load"}`,
      );
    } finally {
      for (const stream of streams) stream.abort();
      if (app) await app.close();
      await pg.close();
      await rm(root, { recursive: true, force: true });
      for (const [name, value] of [
        ["AUTH_PROXY_SECRET", old.secret],
        ["STUDY_ASSET_ROOT", old.root],
        ["DEVELOPER_APP_ORIGIN", old.origin],
      ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);
