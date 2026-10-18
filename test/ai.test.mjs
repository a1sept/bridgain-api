import { test } from "node:test";
import assert from "node:assert/strict";
import { AiService, draftPayload } from "../dist/workspace/ai.service.js";
test("AI drafts cannot hide status changes, assignments or unknown mutations", () => {
  assert.deepEqual(draftPayload("note", { content: "Research findings" }), {
    content: "Research findings",
  });
  assert.throws(() =>
    draftPayload("task", { title: "Task", status: "released" }),
  );
  assert.throws(() =>
    draftPayload("task", { title: "Task", assigneeIds: ["client"] }),
  );
  assert.throws(() =>
    draftPayload("result", { taskId: "not-a-uuid", resultSummary: "done" }),
  );
  assert.throws(() => draftPayload("document", { content: "x".repeat(50001) }));
  assert.throws(() => draftPayload("unknown", {}));
});
test("client project members cannot list or create AI sessions", async () => {
  const tx = new Proxy(
    {},
    {
      get() {
        throw Error("DB accessed before developer authorization");
      },
    },
  );
  const ai = new AiService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: false }) },
    {},
  );
  await assert.rejects(
    ai.list({ id: "client", accountType: "client" }, "project"),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    ai.create({ id: "client", accountType: "client" }, "project", {
      provider: "codex",
      title: "Research",
    }),
    (e) => e.getStatus() === 403,
  );
});
test("other developers cannot read or write an unowned session even in the same project", async () => {
  const query = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    for() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve([]).then(resolve, reject);
    },
  };
  const tx = {
    select: () => query,
    insert() {
      throw Error("Unauthorized write");
    },
  };
  const ai = new AiService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: [
          "requests.read",
          "meetings.read",
          "documents.read",
          "tasks.read",
          "requests.create",
        ],
      }),
    },
    {},
  );
  const id = "abcdef01-1234-4321-abcd-123456789012";
  await assert.rejects(
    ai.detail({ id: "other", accountType: "team" }, id, id),
    (e) => e.getStatus() === 404,
  );
  await assert.rejects(
    ai.message({ id: "other", accountType: "team" }, id, id, {
      role: "user",
      body: "read this",
      clientId: id,
    }),
    (e) => e.getStatus() === 404,
  );
});
test("AI request lookup always uses the session project scope", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  const q = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    then(resolve) {
      return Promise.resolve([{ id }]).then(resolve);
    },
  };
  let call;
  const ai = new AiService(
    { db: { transaction: (fn) => fn({ select: () => q }) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: [
          "requests.read",
          "meetings.read",
          "documents.read",
          "tasks.read",
          "requests.create",
        ],
      }),
      detail: async (...args) => {
        call = args;
        return { request: {} };
      },
    },
    {},
  );
  await ai.tool(
    { id: "developer", accountType: "team" },
    id,
    id,
    "get_request",
    { requestId: id },
  );
  assert.equal(call[1], id);
  assert.equal(call[2], id);
});
function approvalFixture(draft, work, extraRows = []) {
  const rows = [[{ id: "session" }], [draft], ...extraRows];
  const query = (value) => ({
    from() {
      return this;
    },
    where() {
      return this;
    },
    for() {
      return this;
    },
    then(resolve) {
      return Promise.resolve(value).then(resolve);
    },
  });
  let marked = false;
  const inserted = [];
  const tx = {
    insert: (table) => ({
      values: (value) => {
        inserted.push({ table, value });
        return {
          returning: async () => [
            { id: "abcdef01-1234-4321-abcd-123456789012", ...value },
          ],
        };
      },
    }),
    select: () => query(rows.shift()),
    execute: async () => {},
    update: () => ({
      set: () => ({
        where: async () => {
          marked = true;
        },
      }),
    }),
  };
  const service = new AiService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: [
          "requests.read",
          "meetings.read",
          "documents.read",
          "tasks.read",
          "requests.create",
        ],
      }),
    },
    work,
  );
  return { service, tx, inserted, marked: () => marked };
}
test("AI task application creates a development request rather than an executable task", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  const fixture = approvalFixture(
    { id, kind: "task", payload: { title: "Task" }, appliedAt: null },
    {
      saveTask: () => {
        throw Error("must not create task");
      },
    },
  );
  const result = await fixture.service.apply(
    { id: "developer", accountType: "team" },
    id,
    id,
    id,
  );
  assert.equal(result.targetId, id);
  assert.equal(fixture.inserted[0].value.origin, "development");
  assert.equal(fixture.marked(), true);
});
test("repeated approval never creates the same work twice", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  const fixture = approvalFixture(
    {
      id,
      kind: "task",
      payload: { title: "Task" },
      appliedAt: new Date(),
      targetId: id,
    },
    {
      saveTask: () => {
        throw Error("duplicate work");
      },
    },
  );
  const result = await fixture.service.apply(
    { id: "developer", accountType: "team" },
    id,
    id,
    id,
  );
  assert.equal(result.alreadyApplied, true);
  assert.equal(fixture.marked(), false);
});
test("failed development request creation never marks AI draft applied", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  const fixture = approvalFixture(
    { id, kind: "task", payload: { title: "Task" }, appliedAt: null },
    {},
  );
  fixture.tx.insert = () => {
    throw Error("request insert failed");
  };
  await assert.rejects(
    fixture.service.apply({ id: "developer", accountType: "team" }, id, id, id),
    /request insert failed/,
  );
  assert.equal(fixture.marked(), false);
});

test("AI result drafts require the task version and append to completed work in the same transaction", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  assert.throws(() =>
    draftPayload("result", { taskId: id, resultSummary: "Old model context" }),
  );
  let appended = 0;
  const f = approvalFixture(
    {
      id,
      kind: "result",
      title: "API explanation",
      appliedAt: null,
      payload: {
        taskId: id,
        expectedVersion: id,
        apiChanges: "Response details",
      },
    },
    {
      saveTask: () => {
        throw Error("Must not overwrite completed results");
      },
      appendResult: async (u, p, task, body, tx) => {
        appended++;
        assert.equal(task, id);
        assert.equal(body.expectedVersion, id);
        assert.equal(body.changeSummary, "API explanation");
        assert.equal(tx, f.tx);
      },
    },
    [[{ id, status: "done" }]],
  );
  await f.service.apply({ id, accountType: "team" }, id, id, id);
  assert.equal(appended, 1);
  assert.equal(f.marked(), true);
});
test("AI result drafts preserve optimistic concurrency when applying to ongoing work", async () => {
  const id = "abcdef01-1234-4321-abcd-123456789012";
  const f = approvalFixture(
    {
      id,
      kind: "result",
      title: "Result",
      appliedAt: null,
      payload: { taskId: id, expectedVersion: id, resultSummary: "Old draft" },
    },
    {
      saveTask: async (u, p, body) => {
        assert.equal(body.expectedVersion, id);
        throw Object.assign(Error("Task changed"), { getStatus: () => 409 });
      },
    },
    [[{ id, status: "in_progress" }]],
  );
  await assert.rejects(
    f.service.apply({ id, accountType: "team" }, id, id, id),
    (e) => e.getStatus() === 409,
  );
  assert.equal(f.marked(), false);
});

test("revoking area reads denies AI history before any session data query", async () => {
  const tx = new Proxy(
    {},
    {
      get() {
        throw Error("history must not be queried");
      },
    },
  );
  const service = new AiService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: ["requests.read", "tasks.read"],
      }),
    },
    {},
  );
  await assert.rejects(
    service.list({ id: "dev", accountType: "team" }, "project"),
    (e) => e.getStatus() === 403,
  );
});
