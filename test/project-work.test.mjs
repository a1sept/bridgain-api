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
    { access: async () => ({ canManage: false }) },
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
