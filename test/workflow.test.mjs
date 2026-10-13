import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  taskLifecycle,
  requestProgress,
  ProjectWorkService,
} from "../dist/workspace/project-work.service.js";
import {
  verifyGitEvent,
  parseGitEvent,
} from "../dist/workspace/git-events.controller.js";
test("branch connection starts work; completion requires result and merge evidence; deployment requires evidence", () => {
  assert.equal(
    taskLifecycle("todo", "todo", "feature/login", "", "", null),
    "in_progress",
  );
  assert.throws(() =>
    taskLifecycle(
      "todo",
      "done",
      "feature/login",
      "implemented",
      "abcdef1",
      null,
    ),
  );
  assert.throws(() =>
    taskLifecycle("in_progress", "done", "feature/login", "", "abcdef1", null),
  );
  assert.throws(() =>
    taskLifecycle(
      "in_progress",
      "done",
      "feature/login",
      "implemented",
      "bad",
      null,
    ),
  );
  assert.throws(() =>
    taskLifecycle("in_progress", "in_progress", "", "", "", null),
  );
  assert.equal(
    taskLifecycle(
      "in_progress",
      "done",
      "feature/login",
      "implemented",
      "abcdef1",
      null,
    ),
    "done",
  );
  assert.throws(() =>
    taskLifecycle(
      "done",
      "released",
      "feature/login",
      "implemented",
      "abcdef1",
      null,
    ),
  );
  assert.equal(
    taskLifecycle(
      "done",
      "released",
      "feature/login",
      "implemented",
      "abcdef1",
      "https://example.test/deployment/1",
    ),
    "released",
  );
  assert.equal(
    taskLifecycle("released", "in_progress", "feature/fix", "", "", null),
    "in_progress",
  );
});
test("partial completion and partial deployment never complete the entire customer request", () => {
  assert.equal(requestProgress([]), "received");
  assert.equal(requestProgress(["todo", "todo"]), "received");
  assert.equal(requestProgress(["done", "todo"]), "in_progress");
  assert.equal(requestProgress(["released", "in_progress"]), "in_progress");
  assert.equal(requestProgress(["done", "released"]), "completed");
  assert.equal(requestProgress(["released", "released"]), "released");
});
test("Git webhook is disabled without secret and rejects unsigned or tampered payloads", () => {
  const body = Buffer.from('{"action":"closed"}');
  const secret = "a".repeat(64);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.doesNotThrow(() => verifyGitEvent(body, signature, secret));
  assert.throws(() => verifyGitEvent(body, signature, undefined));
  assert.throws(() => verifyGitEvent(body, undefined, secret));
  assert.throws(() => verifyGitEvent(Buffer.from("{}"), signature, secret));
  assert.throws(() => verifyGitEvent(body, "sha256=bad", secret));
});
test("only merged PRs in the connected repository and successful production deployments are actionable", () => {
  const repo = { html_url: "https://github.com/a1sept/bridgain" };
  const p = {
    repository: repo,
    action: "closed",
    pull_request: {
      merged: true,
      base: { repo, ref: "main" },
      head: { repo, ref: "feature/x" },
      merge_commit_sha: "a".repeat(40),
      html_url: repo.html_url + "/pull/1",
    },
  };
  assert.equal(parseGitEvent("pull_request", p, "production").kind, "merge");
  assert.equal(
    parseGitEvent("pull_request", { ...p, action: "opened" }, "production"),
    null,
  );
  assert.equal(
    parseGitEvent(
      "pull_request",
      { ...p, pull_request: { ...p.pull_request, merged: false } },
      "production",
    ),
    null,
  );
  assert.equal(
    parseGitEvent(
      "pull_request",
      {
        ...p,
        pull_request: {
          ...p.pull_request,
          head: {
            ref: "feature/x",
            repo: { html_url: "https://github.com/other/fork" },
          },
        },
      },
      "production",
    ),
    null,
  );
  const d = {
    repository: repo,
    deployment: { environment: "production", sha: "a".repeat(40), ref: "main" },
    deployment_status: {
      state: "success",
      target_url: "https://example.test/build/1",
    },
  };
  assert.equal(
    parseGitEvent("deployment_status", d, "production").kind,
    "deployment",
  );
  assert.equal(parseGitEvent("deployment_status", d, "staging"), null);
  assert.equal(
    parseGitEvent(
      "deployment_status",
      { ...d, deployment_status: { state: "failure" } },
      "production",
    ),
    null,
  );
});
test("meeting finalization and task assignment deny client access before touching DB", async () => {
  const tx = new Proxy(
    {},
    {
      get() {
        throw Error("unauthorized DB access");
      },
    },
  );
  const work = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ canManage: false }) },
  );
  const u = { id: "client", displayName: "client", accountType: "client" };
  await assert.rejects(
    work.saveMeeting(u, "project", { decisionStatus: "final", requests: [] }),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    work.saveTask(u, "project", { assigneeIds: ["client"] }),
    (e) => e.getStatus() === 403,
  );
});
test("final meeting cannot be edited or finalized twice", async () => {
  const query = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    for: async () => [{ id: "existing", decisionStatus: "final" }],
  };
  const work = new ProjectWorkService(
    { db: { transaction: (fn) => fn({ select: () => query }) } },
    { access: async () => ({ canManage: true }) },
  );
  await assert.rejects(
    work.saveMeeting(
      { id: "developer", accountType: "team" },
      "project",
      { decisionStatus: "final" },
      "abcdef01-1234-4321-abcd-123456789012",
    ),
    (e) => e.getStatus() === 409,
  );
});
test("draft meetings reject assignment and final meetings require requests", async () => {
  const work = new ProjectWorkService(
    { db: { transaction: (fn) => fn({}) } },
    { access: async () => ({ canManage: true }) },
  );
  const user = { id: "developer", accountType: "team" };
  await assert.rejects(
    work.saveMeeting(user, "project", {
      decisionStatus: "final",
      requests: [],
    }),
    (e) => e.getStatus() === 400,
  );
  await assert.rejects(
    work.saveMeeting(user, "project", {
      decisionStatus: "draft",
      requests: [
        { requestId: "abcdef01-1234-4321-abcd-123456789012" },
        { requestId: "abcdef01-1234-4321-abcd-123456789012" },
      ],
    }),
    (e) => e.getStatus() === 400,
  );
});
// Small query adapter to exercise service orchestration without starting a database.
function databaseFixture(selections, returned) {
  const writes = [];
  const chain = (value) => ({
    from() {
      return this;
    },
    innerJoin() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return this;
    },
    for() {
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    },
  });
  const tx = {
    select() {
      assert.ok(selections.length, "unexpected SELECT");
      return chain(selections.shift());
    },
    insert(table) {
      return {
        values(value) {
          writes.push({ table, value });
          const row = returned.get(table);
          return {
            ...chain([]),
            returning: () => Promise.resolve(row ? [row] : []),
          };
        },
      };
    },
    update(table) {
      return {
        set(value) {
          writes.push({ table, value });
          return {
            where() {
              return {
                returning: () => Promise.resolve([returned.get(table)]),
              };
            },
          };
        },
      };
    },
    delete() {
      return { where: () => Promise.resolve() };
    },
  };
  return { writes, database: { db: { transaction: (fn) => fn(tx) } } };
}
const schema = await import("../dist/db/schema/project-work.js");
test("final meeting generates linked tasks and developer assignments from request plans", async () => {
  const rid = "abcdef01-1234-4321-abcd-123456789012",
    uid = "abcdef02-1234-4321-abcd-123456789012";
  const fixture = databaseFixture(
    [
      [{ id: uid }],
      [{ id: rid }],
      [{ id: rid, title: "Login request" }],
      [{ status: "todo" }],
      [{ id: rid, status: "received" }],
      [],
    ],
    new Map([
      [
        schema.projectMeetings,
        { id: "meeting", title: "Planning", decisionStatus: "final" },
      ],
      [schema.projectTasks, { id: "task", title: "Login request" }],
    ]),
  );
  const service = new ProjectWorkService(fixture.database, {
    access: async () => ({ canManage: true }),
  });
  await service.saveMeeting({ id: uid, accountType: "team" }, "project", {
    title: "Planning",
    scheduledAt: "2026-10-13T10:00:00Z",
    decisionStatus: "final",
    requests: [
      {
        requestId: rid,
        planning: "Implement login",
        uiNotes: "Login form",
        priority: "high",
        assigneeIds: [uid],
      },
    ],
  });
  assert.equal(
    fixture.writes.filter((w) => w.table === schema.projectTasks).length,
    1,
  );
  assert.equal(
    fixture.writes.find((w) => w.table === schema.projectTasks).value.priority,
    "high",
  );
  assert.deepEqual(
    fixture.writes.find((w) => w.table === schema.taskAssignees).value,
    [{ taskId: "task", userId: uid }],
  );
  assert.equal(
    fixture.writes.find((w) => w.table === schema.meetingRequests).value.taskId,
    "task",
  );
  assert.equal(
    fixture.writes.find((w) => w.table === schema.taskRequests).value.requestId,
    rid,
  );
});
test("non-developer assignees are rejected before any writes", async () => {
  const fixture = databaseFixture([[]], new Map());
  const service = new ProjectWorkService(fixture.database, {
    access: async () => ({ canManage: true }),
  });
  await assert.rejects(
    service.saveTask({ id: "developer", accountType: "team" }, "project", {
      title: "Task",
      assigneeIds: ["abcdef01-1234-4321-abcd-123456789012"],
    }),
    (e) => e.getResponse().code === "INVALID_ASSIGNEE",
  );
  assert.equal(fixture.writes.length, 0);
});
test("first edit preserves legacy document contents and stores the new version with editor and summary", async () => {
  const did = "abcdef01-1234-4321-abcd-123456789012";
  const old = {
    id: did,
    projectId: "project",
    title: "Old API",
    category: "api",
    content: "old response",
    url: null,
    createdBy: "author",
    updatedAt: new Date("2026-10-01"),
  };
  const updated = { ...old, title: "New API", content: "new response" };
  const fixture = databaseFixture(
    [[old], [], [{ name: "Author" }]],
    new Map([[schema.projectDocuments, updated]]),
  );
  const service = new ProjectWorkService(fixture.database, {
    access: async () => ({ canManage: true }),
  });
  await service.saveDocument(
    { id: "editor", accountType: "team" },
    "project",
    { title: "New API", content: "new response", changeSummary: "Added field" },
    did,
  );
  const versions = fixture.writes
    .filter((w) => w.table === schema.documentVersions)
    .map((w) => w.value);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].content, "old response");
  assert.equal(versions[1].content, "new response");
  assert.equal(versions[1].actorId, "editor");
  assert.equal(versions[1].changeSummary, "Added field");
});
