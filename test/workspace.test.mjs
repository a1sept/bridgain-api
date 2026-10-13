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

test("merge approver grants enforce team hierarchy and developer accounts, and support revocation", async () => {
  const actorId = "00000000-0000-4000-8000-000000000001";
  const targetId = "00000000-0000-4000-8000-000000000002";
  const teamId = "00000000-0000-4000-8000-000000000003";
  for (const scenario of [
    { actor: "owner", target: "admin", value: true },
    { actor: "admin", target: "member", value: true },
    { actor: "admin", target: "member", value: false },
    { actor: "owner", target: "owner", self: true, value: true },
    { actor: "member", target: "member", self: true, value: true, error: 403 },
    { actor: "admin", target: "admin", value: true, error: 403 },
    { actor: "admin", target: "owner", value: true, error: 403 },
    {
      actor: "owner",
      target: "member",
      account: "client",
      value: true,
      error: 400,
    },
    {
      actor: "owner",
      target: "member",
      status: "suspended",
      value: true,
      error: 400,
    },
    { actor: "owner", target: "member", status: "suspended", value: false },
    { actor: "owner", target: "member", value: "true", error: 400 },
  ]) {
    let query = 0;
    const writes = [];
    const target = scenario.self ? actorId : targetId;
    const rows = [
      {
        userId: actorId,
        permissionRole: scenario.actor,
        canApproveMerge: false,
      },
      ...(scenario.self
        ? []
        : [
            {
              userId: targetId,
              permissionRole: scenario.target,
              canApproveMerge: true,
            },
          ]),
    ];
    const results = [
      [{ id: teamId }],
      rows,
      [
        {
          id: target,
          accountType: scenario.account ?? "team",
          status: scenario.status ?? "active",
        },
      ],
    ];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            const result = results[query++] ?? [];
            return {
              for: async () => result,
              then: (resolve, reject) =>
                Promise.resolve(result).then(resolve, reject),
            };
          },
        }),
      }),
      update: () => ({
        set: (value) => ({
          where: async () => {
            writes.push(value);
          },
        }),
      }),
    };
    const service = new WorkspaceService({
      db: { transaction: async (fn) => fn(tx) },
    });
    const action = service.member(
      { id: actorId, accountType: "team", displayName: "Actor" },
      teamId,
      target,
      { canApproveMerge: scenario.value },
    );
    if (scenario.error) {
      await assert.rejects(action, (e) => e.getStatus?.() === scenario.error);
      assert.equal(writes.length, 0);
    } else {
      const result = await action;
      assert.equal(result.canApproveMerge, scenario.value);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].canApproveMerge, scenario.value);
      assert.equal(writes[0].permissionRole, scenario.target);
    }
  }
});

test("revoking a team approver invalidates active reviews and records who revoked permission", async () => {
  const { teams, teamMemberships, projects } =
    await import("../dist/db/schema/workspace.js");
  const { users } = await import("../dist/db/schema/auth.js");
  const { projectTasks, taskReviewEvents } =
    await import("../dist/db/schema/project-work.js");
  const owner = "00000000-0000-4000-8000-000000000001";
  const reviewer = "00000000-0000-4000-8000-000000000002";
  const tid = "00000000-0000-4000-8000-000000000003";
  const pid = "00000000-0000-4000-8000-000000000004";
  const task = {
    id: "00000000-0000-4000-8000-000000000005",
    reviewHeadSha: "a".repeat(40),
    reviewBaseSha: "b".repeat(40),
  };
  const writes = [],
    history = [];
  const chain = (fn) => {
    const q = {
      then: (resolve, reject) =>
        Promise.resolve().then(fn).then(resolve, reject),
    };
    for (const name of ["where", "for", "returning"]) q[name] = () => q;
    return q;
  };
  const tx = {
    select: () => ({
      from: (table) =>
        chain(() => {
          if (table === teams) return [{ id: tid }];
          if (table === teamMemberships)
            return [
              {
                userId: owner,
                permissionRole: "owner",
                canApproveMerge: false,
              },
              {
                userId: reviewer,
                permissionRole: "member",
                canApproveMerge: true,
              },
            ];
          if (table === users)
            return [{ id: reviewer, accountType: "team", status: "active" }];
          if (table === projects) return [{ id: pid }];
          return [];
        }),
    }),
    update: (table) => ({
      set: (values) =>
        chain(() => {
          writes.push({ table, values });
          return table === projectTasks ? [task] : [];
        }),
    }),
    insert: (table) => ({
      values: (value) =>
        chain(() => {
          if (table === taskReviewEvents) history.push(value);
        }),
    }),
  };
  const service = new WorkspaceService({ db: { transaction: (fn) => fn(tx) } });
  await service.member({ id: owner, accountType: "team" }, tid, reviewer, {
    canApproveMerge: false,
  });
  assert.equal(
    writes.find((w) => w.table === projectTasks).values.reviewStatus,
    "stale",
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].actorId, owner);
  assert.equal(history[0].taskId, task.id);
  assert.equal(history[0].headSha, task.reviewHeadSha);
});
