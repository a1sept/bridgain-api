import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  RepositoryAccessService,
  repositoryAccessInput,
} from "../dist/workspace/repository-access.service.js";
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
    member: true,
    managerId: mid,
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
      if (sql.startsWith("SELECT r.url"))
        rows.push({
          repositoryUrl: repo,
          managerUserId: state.member ? mid : null,
          managerName: "Manager",
        });
      else if (sql.startsWith("SELECT a.id")) rows.push(...state.requests);
      else if (sql.startsWith("SELECT u.id AS")) {
        if (state.member) rows.push({ userId: mid, displayName: "Manager" });
      } else if (sql.startsWith("SELECT id FROM projects")) {
        if (state.registered) rows.push({ id: pid });
      } else if (sql.startsWith("SELECT u.id,u.display_name")) {
        if (state.member) rows.push({ id: mid, display_name: "Manager" });
      } else if (sql.startsWith("SELECT manager_user_id")) {
        if (state.managerId) rows.push({ manager_user_id: state.managerId });
      } else if (sql.startsWith("INSERT INTO project_repository_managers"))
        state.managerId = p[2];
      else if (
        sql.startsWith("UPDATE repository_access_requests SET manager_user_id")
      )
        state.requests.forEach((r) => {
          if (r.status === "pending") r.manager_user_id = p[0];
        });
      else if (sql.startsWith("INSERT INTO repository_access_requests")) {
        const duplicate = state.requests.some(
          (r) =>
            r.project_id === p[0] &&
            r.repository_url === p[1] &&
            r.requester_id === p[2] &&
            r.status === "pending",
        );
        if (!duplicate) {
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
        rows.push(
          ...state.requests.filter(
            (r) => r.project_id === p[0] && r.id === p[1],
          ),
        );
      else if (sql.startsWith("UPDATE repository_access_requests SET status"))
        state.requests.find((r) => r.id === p[1]).status = "resolved";
      else if (sql.startsWith("INSERT INTO channel_messages"))
        state.messages.push(p[2]);
      else throw Error("Unexpected SQL: " + sql);
      return { rows };
    },
  };
  const access = {
    access: async () => ({
      isDeveloper: state.developer,
      permissions: state.permissions,
    }),
  };
  const service = new RepositoryAccessService(
    { db: { transaction: (fn) => fn(tx) } },
    access,
  );
  return { state, service };
}
test("registered project repo request notifies internal channel once even for concurrent duplicate calls", async () => {
  const { state, service } = fixture();
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      service.request(user, pid, { repositoryUrl: repo, note: "clone denied" }),
    ),
  );
  assert.equal(state.requests.length, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.match(state.messages[0], /Manager/);
  assert.match(state.messages[0], /Worker/);
  assert.ok(state.messages[0].includes(repo));
  assert.ok(
    state.commands.some((s) =>
      s.includes(
        "ON CONFLICT(project_id,repository_url,requester_id) WHERE status='pending'",
      ),
    ),
  );
});
test("request rejects client, unregistered repository, missing or departed responsible member", async () => {
  for (const [key, value, code] of [
    ["developer", false, "FORBIDDEN"],
    ["registered", false, "REPOSITORY_DENIED"],
    ["managerId", null, "REPOSITORY_MANAGER_REQUIRED"],
    ["member", false, "INVALID_REPOSITORY_MANAGER"],
  ]) {
    const { state, service } = fixture();
    state[key] = value;
    await assert.rejects(
      service.request(user, pid, { repositoryUrl: repo }),
      (e) => e.response.code === code,
    );
    assert.equal(state.requests.length, 0);
    assert.equal(state.messages.length, 0);
  }
});
test("manager designation requires project.settings and an active project member; reassigns pending requests", async () => {
  const { state, service } = fixture();
  await assert.rejects(
    service.manager(user, pid, { repositoryUrl: repo, managerUserId: mid }),
    (e) => e.response.code === "FORBIDDEN",
  );
  state.permissions = ["project.settings"];
  state.member = false;
  await assert.rejects(
    service.manager(user, pid, { repositoryUrl: repo, managerUserId: mid }),
    (e) => e.response.code === "INVALID_REPOSITORY_MANAGER",
  );
  state.member = true;
  await service.request(user, pid, { repositoryUrl: repo });
  await service.manager(user, pid, {
    repositoryUrl: repo,
    managerUserId: null,
  });
  assert.equal(state.requests[0].manager_user_id, null);
  await service.manager(user, pid, { repositoryUrl: repo, managerUserId: mid });
  assert.equal(state.requests[0].manager_user_id, mid);
  const messages = state.messages.length;
  await service.manager(user, pid, { repositoryUrl: repo, managerUserId: mid });
  assert.equal(state.messages.length, messages);
});
test("only responsible current member or manager can resolve; idempotent without repeated channel notices", async () => {
  const { state, service } = fixture();
  const { id } = await service.request(user, pid, { repositoryUrl: repo });
  await assert.rejects(
    service.resolve(user, pid, id, { status: "resolved" }),
    (e) => e.response.code === "FORBIDDEN",
  );
  const manager = { ...user, id: mid };
  await service.resolve(manager, pid, id, { status: "resolved" });
  await service.resolve(manager, pid, id, { status: "resolved" });
  assert.equal(state.messages.length, 2);
  assert.equal(state.requests[0].status, "resolved");
  state.developer = false;
  await assert.rejects(
    service.resolve(manager, pid, id, { status: "resolved" }),
    (e) => e.response.code === "FORBIDDEN",
  );
});
test("repository input rejects external hosts and unbounded note", () => {
  assert.throws(() =>
    repositoryAccessInput({ repositoryUrl: "https://evil.test/a/b" }),
  );
  assert.throws(() =>
    repositoryAccessInput({ repositoryUrl: repo, note: "x".repeat(1001) }),
  );
});

test("list returns current actor and eligible members; pending query is not truncated by recent history", async () => {
  const { state, service } = fixture();
  state.member = false;
  const result = await service.list(user, pid);
  assert.equal(result.currentUserId, uid);
  assert.deepEqual(result.members, []);
  assert.equal(result.repositories[0].managerUserId, null);
  assert.equal(result.repositories[0].managerName, null);
  const query = state.commands.find((s) => s.startsWith("SELECT a.id"));
  assert.match(query, /a.status='pending' OR/);
  assert.match(
    query,
    /status='resolved' ORDER BY created_at DESC,id DESC LIMIT 100/,
  );
  assert.ok(!query.endsWith("LIMIT 100"));
});
