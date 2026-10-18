import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedWorkService } from "../dist/workspace/staged-work.service.js";
import {
  projectTasks as tasks,
  taskAssignees,
  taskWorkReviewers,
  taskWorkEvents,
  taskDependencies,
  taskDeploymentAttempts,
} from "../dist/db/schema/project-work.js";
import { users } from "../dist/db/schema/auth.js";
const id = "00000000-0000-4000-8000-000000000001";
const pid = "00000000-0000-4000-8000-000000000002";
const u = {
  id: "00000000-0000-4000-8000-000000000003",
  displayName: "담당자",
  accountType: "team",
};
const other = "00000000-0000-4000-8000-000000000004";
function fixture(overrides = {}) {
  let task = {
    id,
    projectId: pid,
    stageKey: "planning",
    status: "in_progress",
    completionMode: "document",
    repositoryUrl: "https://github.com/example/staged",
    pullRequestUrl: "https://github.com/example/staged/pull/1",
    liveBranch: "main",
    workBranch: "feature/work",
    workRevision: 1,
    reviewHeadSha: "",
    approvedHeadSha: "",
    resultSummary: "결과",
    verification: "검증",
    ...overrides,
  };
  let descendants = [];
  let assigned = [{ taskId: id, userId: u.id, completedAt: null }];
  let reviewers = [
    { taskId: id, userId: u.id, status: "pending" },
    { taskId: id, userId: other, status: "pending" },
  ];
  const events = [],
    attempts = [];
  let permissions = [
    "tasks.read",
    "tasks.progress",
    "approvals.work",
    "deploy.run",
  ];
  const chain = (fn) => {
    const q = { then: (yes, no) => Promise.resolve().then(fn).then(yes, no) };
    for (const name of ["where", "for", "orderBy", "innerJoin", "limit"])
      q[name] = () => q;
    q.returning = () => q;
    return q;
  };
  const tx = {
    select: () => ({
      from: (table) =>
        chain(() =>
          table === tasks
            ? [task]
            : table === taskAssignees
              ? assigned
              : table === taskWorkReviewers
                ? reviewers
                : table === taskDependencies
                  ? descendants.map((task) => ({ task }))
                  : table === users
                    ? [{ ...u, status: "active" }]
                    : [],
        ),
    }),
    update: (table) => ({
      set: (values) =>
        chain(() => {
          if (table === tasks) task = { ...task, ...values };
          if (table === taskAssignees)
            assigned = assigned.map((a) =>
              values.completedAt === null || a.userId === u.id
                ? { ...a, ...values }
                : a,
            );
          if (table === taskDeploymentAttempts)
            attempts.forEach((a) => Object.assign(a, values));
          if (table === taskWorkReviewers) {
            // approve targets current actor; fixture has one pending other reviewer.
            if (values.status === "approved")
              reviewers = reviewers.map((v) =>
                v.userId === u.id ? { ...v, ...values } : v,
              );
            else reviewers = reviewers.map((v) => ({ ...v, ...values }));
          }
        }),
    }),
    insert: (table) => ({
      values: (values) =>
        chain(() => {
          if (table === taskWorkEvents) events.push(values);
          if (table === taskDeploymentAttempts) {
            const a = { id: "attempt", ...values };
            attempts.push(a);
            return [a];
          }
          return [values];
        }),
    }),
    execute: async () => {},
  };
  const service = new StagedWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: true, permissions }) },
  );
  return {
    service,
    tx,
    setDescendants: (value) => (descendants = value),
    get task() {
      return task;
    },
    attempts,
    get assigned() {
      return assigned;
    },
    get reviewers() {
      return reviewers;
    },
    events,
    setPermissions: (value) => (permissions = value),
    setAssigned: (value) => (assigned = value),
    setReviewers: (value) => (reviewers = value),
  };
}
test("all assignees complete before review; own work approval does not bypass other reviewers", async () => {
  const f = fixture();
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "complete",
      })
    ).status,
    "review_pending",
  );
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "approve",
      })
    ).status,
    "review_pending",
  );
  assert.equal(f.task.status, "review_pending");
  assert.equal(f.reviewers[1].status, "pending");
});
test("final explicitly designated reviewer approval completes non-code task", async () => {
  const f = fixture({ status: "review_pending" });
  f.setAssigned([{ userId: u.id, completedAt: new Date() }]);
  f.setReviewers([
    { userId: u.id, status: "pending" },
    { userId: other, status: "approved" },
  ]);
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "approve",
      })
    ).status,
    "done",
  );
});
test("review cannot skip assignee completion", async () => {
  const f = fixture({ status: "review_pending" });
  await assert.rejects(
    f.service.act(u, pid, id, { expectedRevision: 1, action: "approve" }),
    (e) => e.response.code === "COMPLETION_REQUIRED",
  );
});
test("rework requires note, resets approved non-code task completions and votes", async () => {
  const f = fixture({ status: "done" });
  f.setAssigned([{ userId: u.id, completedAt: new Date() }]);
  f.setReviewers([{ userId: u.id, status: "approved" }]);
  await assert.rejects(
    f.service.act(u, pid, id, {
      expectedRevision: 1,
      action: "changes_requested",
      note: "",
    }),
  );
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "changes_requested",
        note: "내용 보완",
      })
    ).status,
    "in_progress",
  );
  assert.equal(f.task.workRevision, 2);
  assert.equal(f.assigned[0].completedAt, null);
  assert.equal(f.reviewers[0].status, "pending");
  assert.equal(f.events.at(-1).note, "내용 보완");
});
test("non-designated approver and missing approval permission are rejected", async () => {
  const f = fixture({ status: "review_pending" });
  f.setReviewers([{ userId: other, status: "pending" }]);
  await assert.rejects(
    f.service.act(u, pid, id, { expectedRevision: 1, action: "approve" }),
    (e) => e.response.code === "REVIEWER_REQUIRED",
  );
  f.setPermissions(["tasks.read"]);
  await assert.rejects(
    f.service.act(u, pid, id, { expectedRevision: 1, action: "approve" }),
    (e) => e.response.code === "FORBIDDEN",
  );
});
test("released task is immutable and requires new request", async () => {
  const f = fixture({ status: "released" });
  await assert.rejects(
    f.service.act(u, pid, id, {
      expectedRevision: 1,
      action: "changes_requested",
      note: "변경",
    }),
    (e) => e.response.code === "NEW_REQUEST_REQUIRED",
  );
});
test("manual deployed confirmation requires actual prior merge and deploy permission", async () => {
  const f = fixture({ status: "deploy_pending" });
  await assert.rejects(
    f.service.deployed(u, pid, id, { url: "https://example.test" }),
    (e) => e.response.code === "INVALID_TRANSITION",
  );
  const ready = fixture({ status: "deploying", mergeCommit: "a".repeat(40) });
  assert.equal(
    (await ready.service.deployed(u, pid, id, { url: "https://example.test" }))
      .status,
    "released",
  );
  assert.equal(ready.task.deploymentUrl, "https://example.test");
});
test("two assignees cannot enter review after just one completes", async () => {
  const f = fixture();
  f.setAssigned([
    { userId: u.id, completedAt: null },
    { userId: other, completedAt: null },
  ]);
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "complete",
      })
    ).status,
    "in_progress",
  );
  assert.equal(f.assigned[1].completedAt, null);
  await assert.rejects(
    f.service.act(u, pid, id, { expectedRevision: 1, action: "complete" }),
    (e) => e.response.code === "ALREADY_COMPLETED",
  );
});
test("stale revision cannot approve or request rework", async () => {
  const f = fixture({ workRevision: 2, status: "review_pending" });
  for (const action of ["approve", "changes_requested"])
    await assert.rejects(
      f.service.act(u, pid, id, { expectedRevision: 1, action, note: "보완" }),
      (e) => e.response.code === "WORK_REVISION_CHANGED",
    );
});
const sha = "a".repeat(40),
  base = "b".repeat(40),
  merged = "c".repeat(40);
async function withGithub(fn) {
  const oldFetch = global.fetch,
    oldToken = process.env.GITHUB_MERGE_TOKEN,
    oldRepos = process.env.GITHUB_PROJECT_REPOSITORIES;
  process.env.GITHUB_MERGE_TOKEN = "test";
  process.env.GITHUB_PROJECT_REPOSITORIES = JSON.stringify({
    [pid]: ["https://github.com/example/staged"],
  });
  const pr = {
    html_url: "https://github.com/example/staged/pull/1",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    head: {
      sha,
      ref: "feature/work",
      repo: { html_url: "https://github.com/example/staged" },
    },
    base: {
      sha: base,
      ref: "main",
      repo: { html_url: "https://github.com/example/staged" },
    },
  };
  const calls = [];
  const state = {
    pr,
    mergeResponse: { merged: true, sha: merged },
    network: false,
  };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/merge") && state.network) throw new Error("network");
    return new Response(
      JSON.stringify(url.endsWith("/merge") ? state.mergeResponse : state.pr),
      { status: 200 },
    );
  };
  try {
    await fn(state, calls);
  } finally {
    global.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.GITHUB_MERGE_TOKEN;
    else process.env.GITHUB_MERGE_TOKEN = oldToken;
    if (oldRepos === undefined) delete process.env.GITHUB_PROJECT_REPOSITORIES;
    else process.env.GITHUB_PROJECT_REPOSITORIES = oldRepos;
  }
}
function deployFixture() {
  const f = fixture({
    completionMode: "code",
    status: "deploy_pending",
    approvedHeadSha: sha,
    reviewHeadSha: sha,
  });
  f.setAssigned([{ userId: u.id, completedAt: new Date() }]);
  f.setReviewers([{ userId: u.id, status: "approved" }]);
  return f;
}
test("manual batch deploy merges approved exact SHA, retains attempt, repeated deploy does not merge twice", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    const result = await f.service.deploy(u, pid, { taskIds: [id] });
    assert.equal(result.results[0].status, "deploying");
    assert.equal(f.task.mergeCommit, merged);
    assert.equal(f.attempts[0].status, "merged");
    assert.equal(
      JSON.parse(calls.find((c) => c.url.endsWith("/merge")).options.body).sha,
      sha,
    );
    await f.service.deploy(u, pid, { taskIds: [id] });
    assert.equal(calls.filter((c) => c.url.endsWith("/merge")).length, 1);
  }));
test("stale code invalidates votes and assignee completions without merge", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    state.pr.head.sha = "d".repeat(40);
    const result = await f.service.deploy(u, pid, { taskIds: [id] });
    assert.equal(result.results[0].status, "in_progress");
    assert.equal(f.reviewers[0].status, "pending");
    assert.equal(f.assigned[0].completedAt, null);
    assert.equal(calls.filter((c) => c.url.endsWith("/merge")).length, 0);
  }));
test("merge conflict requires rework; network ambiguity remains retryable", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    state.pr.mergeable = false;
    assert.equal(
      (await f.service.deploy(u, pid, { taskIds: [id] })).results[0].status,
      "in_progress",
    );
    assert.equal(f.attempts[0].status, "failed");
    state.pr.mergeable = true;
    state.network = true;
    const retry = deployFixture();
    assert.equal(
      (await retry.service.deploy(u, pid, { taskIds: [id] })).results[0].status,
      "deploy_pending",
    );
    assert.equal(retry.attempts[0].status, "failed");
  }));
test("mismatched base branch cannot be deployed and no Github merge is called", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    state.pr.base.ref = "production";
    assert.equal(
      (await f.service.deploy(u, pid, { taskIds: [id] })).results[0].status,
      "failed",
    );
    assert.equal(calls.filter((c) => c.url.endsWith("/merge")).length, 0);
  }));
test("batch deploy denies missing deploy permission before external calls", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    f.setPermissions(["tasks.read"]);
    await assert.rejects(
      f.service.deploy(u, pid, { taskIds: [id] }),
      (e) => e.response.code === "FORBIDDEN",
    );
    assert.equal(calls.length, 0);
  }));
test("rework cannot reopen predecessor of deploying or released descendant", async () => {
  for (const status of ["deploying", "released"]) {
    const f = fixture({ status: "done" });
    f.setDescendants([{ ...f.task, id: other, status }]);
    await assert.rejects(
      f.service.reset(f.tx, f.task, u.id, "내용 보완"),
      (e) => e.response.code === "NEW_REQUEST_REQUIRED",
    );
    assert.equal(f.task.status, "done");
    assert.equal(f.task.workRevision, 1);
    assert.equal(f.events.length, 0);
  }
});
test("null bodies fail as validation errors rather than server errors", async () => {
  const f = fixture();
  for (const method of [
    () => f.service.act(u, pid, id, null),
    () => f.service.deploy(u, pid, null),
    () => f.service.deployed(u, pid, id, null),
  ])
    await assert.rejects(
      method(),
      (e) => e.response.code === "VALIDATION_ERROR",
    );
});
test("standalone deployment checkpoint can complete with deployment URL and all approvals", async () => {
  const f = fixture({
    status: "review_pending",
    completionMode: "deploy",
    deploymentUrl: "https://example.test",
  });
  f.setAssigned([{ userId: u.id, completedAt: new Date() }]);
  f.setReviewers([{ userId: u.id, status: "pending" }]);
  assert.equal(
    (
      await f.service.act(u, pid, id, {
        expectedRevision: 1,
        action: "approve",
      })
    ).status,
    "released",
  );
});
