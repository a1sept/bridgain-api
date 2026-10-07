import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceController } from "../dist/workspace/workspace.controller.js";
import {
  WorkspaceService,
  invitationAvailable,
  canManageMember,
  uuid,
  bounded,
} from "../dist/workspace/workspace.service.js";
import { token } from "../dist/auth/security.js";
test("workspace mutations reject forged proxy, cross-app cookie, Origin and CSRF before DB access", async () => {
  process.env.AUTH_PROXY_SECRET =
    "workspace-test-secret-at-least-32-characters";
  for (const change of [
    (h) => delete h["x-bridgain-proxy-secret"],
    (h) => (h.origin = "https://bad.test"),
    (h) => (h["x-csrf-token"] = token()),
    (h) => (h.cookie = h.cookie.replaceAll("developer", "client")),
  ]) {
    const csrf = token();
    const h = {
      "x-bridgain-proxy-secret": process.env.AUTH_PROXY_SECRET,
      "x-bridgain-app": "developer",
      origin: "http://localhost:15174",
      cookie: `bridgain_developer_csrf=${csrf}; bridgain_developer_session=session`,
      "x-csrf-token": csrf,
    };
    change(h);
    let calls = 0;
    const c = new WorkspaceController(
      {
        origin: () => "http://localhost:15174",
        me: async () => {
          calls++;
          return { user: { id: "u" } };
        },
      },
      { create: () => calls++ },
    );
    await assert.rejects(
      c.create({ get: (k) => h[k] }, { setHeader: () => {} }, { name: "test" }),
      (e) => e.getStatus() === 403,
    );
    assert.equal(calls, 0);
  }
});
test("workspace reads require app-scoped authentication and disable caching", async () => {
  process.env.AUTH_PROXY_SECRET =
    "workspace-test-secret-at-least-32-characters";
  const h = {
    "x-bridgain-proxy-secret": process.env.AUTH_PROXY_SECRET,
    "x-bridgain-app": "client",
    cookie: "bridgain_developer_session=wrong; bridgain_client_session=correct",
  };
  let args;
  const headers = {};
  const c = new WorkspaceController(
    {
      me: async (...v) => {
        args = v;
        return { user: { id: "u" } };
      },
    },
    { snapshot: (u) => u },
  );
  assert.deepEqual(
    await c.get(
      { get: (k) => h[k] },
      { setHeader: (k, v) => (headers[k] = v) },
    ),
    { id: "u" },
  );
  assert.deepEqual(args, ["client", "correct"]);
  assert.equal(headers["Cache-Control"], "no-store");
});
test("admin cannot promote, edit peers or owner; owner cannot demote ownership", () => {
  for (const [actor, target, next] of [
    ["admin", "member", "admin"],
    ["admin", "admin", "admin"],
    ["admin", "owner", "member"],
    ["owner", "owner", "member"],
    ["member", "member", "member"],
  ])
    assert.equal(canManageMember(actor, target, next), false);
  assert.equal(canManageMember("owner", "member", "admin"), true);
  assert.equal(canManageMember("admin", "member", "member"), true);
});
test("IDs and user text are bounded before reaching SQL", () => {
  assert.throws(() => uuid("not-a-uuid"));
  assert.throws(() => bounded(" ", 120));
  assert.throws(() => bounded("x".repeat(2001), 2000, false));
  assert.equal(bounded(" hello ", 120), "hello");
  assert.equal(bounded("", 2000, false), "");
  assert.equal(
    uuid("00000000-0000-4000-8000-000000000000"),
    "00000000-0000-4000-8000-000000000000",
  );
});

test("stale invitations cannot enroll users after inviter demotion, suspension or removal", () => {
  assert.equal(invitationAvailable("active", "team", "admin", true), true);
  for (const args of [
    ["suspended", "team", "owner", true],
    ["active", "team", "member", true],
    ["active", "team", "owner", false],
    ["active", "client", "admin", true],
    [undefined, undefined, undefined, false],
  ])
    assert.equal(invitationAvailable(...args), false);
});

test("project creation rejects invalid, duplicate and self invitees before opening a transaction", async () => {
  const actor = {
    id: "00000000-0000-4000-8000-000000000001",
    displayName: "owner",
    accountType: "team",
  };
  const other = "aaaaaaaa-0000-4000-8000-000000000002";
  const service = new WorkspaceService({
    get db() {
      throw new Error("Unexpected database access");
    },
  });
  for (const inviteeIds of [
    null,
    other,
    ["invalid"],
    [other, other.toUpperCase()],
    Array(21).fill(other),
  ]) {
    await assert.rejects(
      service.create(actor, { name: "Project", inviteeIds }),
      (e) => e.getStatus?.() === 400,
    );
  }
  await assert.rejects(
    service.create(actor, { name: "Project", inviteeIds: [actor.id] }),
    (e) => e.getStatus?.() === 409,
  );
});

test("missing or inactive creation invitees abort before any project or team inserts", async () => {
  let inserts = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => [],
          then: (resolve) => Promise.resolve([]).then(resolve),
        }),
      }),
    }),
    insert: () => {
      inserts++;
      throw new Error("Unexpected insert");
    },
  };
  const service = new WorkspaceService({
    db: { transaction: async (fn) => fn(tx) },
  });
  await assert.rejects(
    service.create(
      {
        id: "00000000-0000-4000-8000-000000000001",
        displayName: "owner",
        accountType: "team",
      },
      { name: "Project", inviteeIds: ["00000000-0000-4000-8000-000000000002"] },
    ),
    (e) => e.getStatus?.() === 404,
  );
  assert.equal(inserts, 0);
});

test("member search validates input and rejects clients before DB access", async () => {
  const service = new WorkspaceService({
    get db() {
      throw new Error("Unexpected DB access");
    },
  });
  const actor = {
    id: "00000000-0000-4000-8000-000000000001",
    accountType: "team",
  };
  for (const [q, type] of [
    [undefined, "client"],
    [[], "team"],
    ["a", "client"],
    ["  ", "team"],
    ["x".repeat(101), "client"],
    ["valid", undefined],
    ["valid", ["team"]],
    ["valid", "admin"],
  ]) {
    await assert.rejects(
      service.searchUsers(actor, q, type),
      (e) => e.getStatus?.() === 400,
    );
  }
  await assert.rejects(
    service.searchUsers({ ...actor, accountType: "client" }, "name", "team"),
    (e) => e.getStatus?.() === 403,
  );
});

test("member search restricts public fields, scopes results, escapes wildcard names and accepts exact UUID", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const queries = [];
  const db = drizzle({
    query: async (query, params) => {
      queries.push({ sql: query.text, params });
      return { rows: [] };
    },
  });
  const service = new WorkspaceService({ db });
  const actor = {
    id: "00000000-0000-4000-8000-000000000001",
    accountType: "team",
  };
  assert.deepEqual(await service.searchUsers(actor, "  Dev_%\\  ", "client"), {
    users: [],
  });
  assert.deepEqual(queries[0].params, [
    "active",
    "client",
    actor.id,
    "%Dev\\_\\%\\\\%",
    20,
  ]);
  assert.match(queries[0].sql, /"users"\."id" <>/);
  assert.match(queries[0].sql, /"users"\."display_name" ilike/);
  assert.match(
    queries[0].sql,
    /order by "users"\."display_name" asc, "users"\."id" asc limit/,
  );
  assert.doesNotMatch(queries[0].sql, /email/);
  const target = "AAAAAAAA-0000-4000-8000-000000000002";
  await service.searchUsers(actor, target, "team");
  assert.deepEqual(queries[1].params, ["active", "team", actor.id, target, 20]);
  assert.doesNotMatch(queries[1].sql, /ilike/);
});

test("member search authenticates before querying and disables caching", async () => {
  process.env.AUTH_PROXY_SECRET =
    "workspace-test-secret-at-least-32-characters";
  let searched = 0;
  const headers = {};
  const h = {
    "x-bridgain-proxy-secret": process.env.AUTH_PROXY_SECRET,
    "x-bridgain-app": "developer",
    cookie: "bridgain_developer_session=session",
  };
  const c = new WorkspaceController(
    {
      me: async (app, session) => {
        assert.equal(app, "developer");
        assert.equal(session, "session");
        return { user: { id: "u", accountType: "team" } };
      },
    },
    {
      searchUsers: async (u, q, type) => {
        searched++;
        assert.equal(u.id, "u");
        assert.equal(q, "name");
        assert.equal(type, "client");
        return { users: [] };
      },
    },
  );
  const res = { setHeader: (k, v) => (headers[k] = v) };
  await assert.rejects(
    c.searchUsers({ get: () => undefined }, res, "name", "client"),
    (e) => e.getStatus?.() === 403,
  );
  assert.equal(searched, 0);
  assert.deepEqual(
    await c.searchUsers({ get: (k) => h[k] }, res, "name", "client"),
    { users: [] },
  );
  assert.equal(headers["Cache-Control"], "no-store");
});
