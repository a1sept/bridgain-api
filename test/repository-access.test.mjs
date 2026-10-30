import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  RepositoryAccessService,
  repositoryAccessInput,
} from "../dist/workspace/repository-access.service.js";
import { recordRepositoryRegistrations } from "../dist/workspace/repository-registration.js";
const pid = "00000000-0000-4000-8000-000000000001",
  mid = "00000000-0000-4000-8000-000000000002",
  uid = "00000000-0000-4000-8000-000000000003";
const repo = "https://github.com/example/repo",
  user = { id: uid, displayName: "Worker", accountType: "team" };
function fixture() {
  const state = {
    developer: true,
    permissions: [],
    registered: true,
    registrant: mid,
    creator: uid,
    members: [
      { id: mid, display_name: "Registrant" },
      { id: uid, display_name: "Worker" },
    ],
    admins: [],
    requests: [],
    messages: [],
    commands: [],
  };
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement) => {
      const { sql, params: p } = dialect.sqlToQuery(statement);
      state.commands.push(sql);
      const rows = [];
      if (sql.startsWith("SELECT id FROM projects")) {
        if (state.registered) rows.push({ id: pid });
      } else if (sql.startsWith("SELECT unnest")) {
        if (state.registered) rows.push({ repository_url: repo });
      } else if (sql.startsWith("SELECT p.created_by"))
        rows.push({
          created_by: state.creator,
          registered_by: state.registrant,
          registered_name: state.registrant ? "Registrant" : null,
        });
      else if (sql.startsWith("SELECT u.id,u.display_name"))
        rows.push(...state.members);
      else if (sql.startsWith("SELECT a.id"))
        rows.push(
          ...state.requests.map((r) => ({
            id: r.id,
            repositoryUrl: r.repository_url,
            recipientUserId: r.manager_user_id,
            status: r.status,
          })),
        );
      else if (sql.startsWith("INSERT INTO repository_access_requests")) {
        if (!state.requests.some((r) => r.status === "pending")) {
          const r = {
            id: "00000000-0000-4000-8000-000000000010",
            project_id: p[0],
            repository_url: p[1],
            requester_id: p[2],
            manager_user_id: p[3],
            note: p[4],
            status: "pending",
          };
          state.requests.push(r);
          rows.push({ id: r.id });
        }
      } else if (sql.startsWith("SELECT id FROM repository_access_requests"))
        rows.push(...state.requests.filter((r) => r.status === "pending"));
      else if (sql.startsWith("SELECT * FROM repository_access_requests"))
        rows.push(...state.requests.filter((r) => r.id === p[1]));
      else if (
        sql.startsWith("UPDATE repository_access_requests SET manager_user_id")
      )
        state.requests.find((r) => r.id === p[1]).manager_user_id = p[0];
      else if (sql.startsWith("UPDATE repository_access_requests SET status"))
        state.requests.find((r) => r.id === p[2]).status = "resolved";
      else if (sql.startsWith("INSERT INTO channel_messages"))
        state.messages.push(p[2]);
      else throw Error(sql);
      return { rows };
    },
  };
  const service = new RepositoryAccessService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async (_tx, actor) => ({
        isDeveloper: state.developer,
        permissions: state.admins.includes(actor.id)
          ? ["project.settings"]
          : state.permissions,
      }),
    },
  );
  return { state, service };
}
test("requests automatically route to server recorded registrant and deduplicate concurrent calls", async () => {
  const { state, service } = fixture();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.request(user, pid, {
        repositoryUrl: repo,
        managerUserId: uid,
        registeredBy: uid,
        note: "denied",
      }),
    ),
  );
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].manager_user_id, mid);
  assert.equal(state.messages.length, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.match(state.messages[0], /Registrant/);
  assert.equal(service.manager, undefined);
});
test("legacy repo identifies creator fallback without inventing registrant provenance", async () => {
  const { state, service } = fixture();
  state.registrant = null;
  const info = (await service.list(user, pid)).repositories[0];
  assert.equal(info.registeredByUserId, null);
  assert.equal(info.recipientUserId, uid);
  assert.equal(info.recipientSource, "project_creator");
  await service.request(user, pid, { repositoryUrl: repo });
  assert.equal(state.requests[0].manager_user_id, uid);
});
test("departed registrant routes to current settings administrator; no recipient fails clearly", async () => {
  const { state, service } = fixture();
  await service.request(user, pid, { repositoryUrl: repo });
  state.members = state.members.filter((m) => m.id !== mid);
  state.admins = [uid];
  const info = (await service.list(user, pid)).repositories[0];
  assert.equal(info.registeredByUserId, mid);
  assert.equal(info.recipientSource, "project_admin");
  const duplicate = await service.request(user, pid, { repositoryUrl: repo });
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.requests[0].manager_user_id, uid);
  assert.equal(state.messages.length, 1);
  state.admins = [];
  await assert.rejects(
    service.request(user, pid, { repositoryUrl: repo }),
    (e) => e.response.code === "REPOSITORY_RECIPIENT_UNAVAILABLE",
  );
});
test("client and unregistered repository denied before request insert", async () => {
  for (const [key, code] of [
    ["developer", "FORBIDDEN"],
    ["registered", "REPOSITORY_DENIED"],
  ]) {
    const { state, service } = fixture();
    state[key] = false;
    await assert.rejects(
      service.request(user, pid, { repositoryUrl: repo }),
      (e) => e.response.code === code,
    );
    assert.equal(state.requests.length, 0);
  }
});
test("resolve uses current automatic routing, rejects unrelated actor, remains idempotent", async () => {
  const { state, service } = fixture();
  const { id } = await service.request(user, pid, { repositoryUrl: repo });
  await assert.rejects(
    service.resolve(user, pid, id, { status: "resolved" }),
    (e) => e.response.code === "FORBIDDEN",
  );
  await service.resolve({ ...user, id: mid }, pid, id, { status: "resolved" });
  await service.resolve({ ...user, id: mid }, pid, id, { status: "resolved" });
  assert.equal(state.messages.length, 2);
});
test("provenance records new URLs under authenticated actor, preserves existing URL on settings save", async () => {
  const calls = [],
    dialect = new PgDialect(),
    tx = { execute: async (q) => calls.push(dialect.sqlToQuery(q)) };
  await recordRepositoryRegistrations(
    tx,
    pid,
    uid,
    [repo],
    [repo, "https://github.com/example/new"],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [
    pid,
    "https://github.com/example/new",
    uid,
  ]);
  await recordRepositoryRegistrations(
    tx,
    pid,
    mid,
    [repo],
    [repo.toUpperCase()],
  );
  assert.equal(calls.length, 1);
});
test("input rejects invalid hosts and unbounded note", () => {
  assert.throws(() =>
    repositoryAccessInput({ repositoryUrl: "https://evil.test/a/b" }),
  );
  assert.throws(() =>
    repositoryAccessInput({ repositoryUrl: repo, note: "x".repeat(1001) }),
  );
});
