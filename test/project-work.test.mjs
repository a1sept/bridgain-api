import { allProjectPermissions } from "../dist/workspace/project-roles.service.js";
import { test } from "node:test";
import assert from "node:assert/strict";
const base = process.env.PROJECT_WORK_DIST || "../dist";
const { ProjectWorkService, dueDate, documentUrl, meetingDate, ids, choice } =
  await import(`${base}/workspace/project-work.service.js`);
test("calendar dates reject normalized invalid dates and support clearing", () => {
  assert.equal(dueDate("2028-02-29"), "2028-02-29");
  assert.equal(dueDate(null), null);
  for (const value of [
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "tomorrow",
    {},
    42,
  ])
    assert.throws(() => dueDate(value));
});
test("documents reject script schemes and credential-bearing URLs", () => {
  assert.equal(
    documentUrl("https://example.com/spec"),
    "https://example.com/spec",
  );
  assert.equal(documentUrl(null), null);
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/spec",
    "https://user:password@example.com",
    "bad",
  ])
    assert.throws(() => documentUrl(value));
});
test("meeting timestamps require valid dates and explicit timezone", () => {
  assert.equal(
    meetingDate("2026-10-01T09:30:00+09:00").toISOString(),
    "2026-10-01T00:30:00.000Z",
  );
  for (const value of ["2026-10-01T09:30", "2026-02-30T09:30:00Z", "invalid"])
    assert.throws(() => meetingDate(value));
});
test("linked IDs are validated, canonicalized, deduplicated and bounded", () => {
  const id = "ABCDEF01-1234-4321-ABCD-123456789012";
  assert.deepEqual(ids([id, id.toLowerCase()]), [id.toLowerCase()]);
  assert.throws(() => ids(["bad"]));
  assert.throws(() => ids(Array(51).fill(id)));
  assert.throws(() => ids({}));
  assert.throws(() => choice("released", ["todo", "in_progress", "done"]));
});
test("every internal read and write denies client project members before data access", async () => {
  const tx = new Proxy(
    {},
    {
      get() {
        throw new Error("Data accessed before authorization");
      },
    },
  );
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: false }) },
  );
  const user = { id: "client", displayName: "Client", accountType: "client" };
  for (const [method, args] of [
    ["listTasks", []],
    ["saveTask", [{}]],
    ["listMeetings", []],
    ["saveMeeting", [{}]],
    ["listDocuments", []],
    ["saveDocument", [{}]],
    ["listActivity", []],
  ]) {
    await assert.rejects(
      service[method](user, "project", ...args),
      (e) => e.getStatus() === 403,
    );
  }
});
test("membership failure propagates without reading project work", async () => {
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn({}) } },
    {
      access: async () => {
        throw new Error("Not a project member");
      },
    },
  );
  await assert.rejects(
    service.listTasks({ id: "stranger", accountType: "team" }, "project"),
    /Not a project member/,
  );
});

test("project roles deny each ungranted area before accessing work data", async () => {
  const tx = new Proxy(
    {},
    {
      get() {
        throw Error("Unexpected data access");
      },
    },
  );
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: true, permissions: [] }) },
  );
  const user = { id: "restricted", accountType: "team" };
  for (const [method, args] of [
    ["listTasks", []],
    ["saveTask", [{}]],
    ["listMeetings", []],
    ["saveMeeting", [{}]],
    ["listDocuments", []],
    ["saveDocument", [{}]],
    ["listActivity", []],
  ])
    await assert.rejects(
      service[method](user, "project", ...args),
      (e) => e.getStatus() === 403,
    );
});

test("task-only readers cannot retrieve linked request or document metadata through tasks", async () => {
  const {
    projectTasks,
    taskAssignees,
    taskResultEntries,
    documentVersions,
    taskRequests,
  } = await import("../dist/db/schema/project-work.js");
  const touched = [];
  const tx = {
    select: () => ({
      from: (table) => {
        touched.push(table);
        if (table === documentVersions || table === taskRequests)
          throw Error("Restricted metadata queried");
        const q = {
          innerJoin: () => q,
          where: () => q,
          orderBy: () => q,
          then: (resolve) =>
            Promise.resolve(
              table === projectTasks
                ? [{ id: "task", title: "Approved work" }]
                : [],
            ).then(resolve),
        };
        return q;
      },
    }),
  };
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({ isDeveloper: true, permissions: ["tasks.read"] }),
    },
  );
  const result = await service.listTasks(
    { id: "reader", accountType: "team" },
    "project",
  );
  assert.deepEqual(result.tasks[0].documentVersions, []);
  assert.deepEqual(result.tasks[0].requests, []);
  assert.deepEqual(result.tasks[0].requestIds, []);
  assert.ok(touched.includes(taskAssignees));
  assert.ok(touched.includes(taskResultEntries));
});

test("activity-only readers cannot retrieve comments or content from denied areas", async () => {
  const { projectActivity } = await import("../dist/db/schema/project-work.js");
  const tx = {
    select: () => ({
      from: (table) => {
        assert.equal(
          table,
          projectActivity,
          "request comments must not be queried",
        );
        const q = {
          innerJoin: () => q,
          where: () => q,
          orderBy: () => q,
          limit: () => q,
          then: (resolve) =>
            Promise.resolve(
              [
                "task_updated",
                "document_updated",
                "meeting_updated",
                "request_transferred",
                "future_kind",
              ].map((kind) => ({
                kind,
                body: "private content",
                createdAt: new Date(),
              })),
            ).then(resolve),
        };
        return q;
      },
    }),
  };
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: ["activity.read"],
      }),
    },
  );
  const result = await service.listActivity(
    { id: "reader", accountType: "team" },
    "project",
  );
  assert.deepEqual(result.events, []);
});
