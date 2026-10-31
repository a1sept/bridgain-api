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
import { projects } from "../dist/db/schema/workspace.js";
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
  const taskWrites = [];
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
    for (const name of ["onConflictDoNothing", "where", "for", "orderBy", "innerJoin", "limit"])
      q[name] = () => q;
    q.returning = () => q;
    return q;
  };
  const tx = {
    select: () => ({
      from: (table) =>
        chain(() =>
          table === projects ? [{ id: pid, repositoryUrls: ["https://github.com/example/staged"] }] : table === tasks
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
          if (table === tasks) { taskWrites.push(values); task = { ...task, ...values }; }
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
    { db: { ...tx, transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: true, permissions }) },
    { status: async () => ({ connected: true }), repositoryRequest: async (uid, repository, suffix, method, body) => {
      assert.equal(uid, u.id);
      const response = await fetch(`https://api.github.com/repos/${repository.slice("https://github.com/".length)}${suffix}`, {method, body: body ? JSON.stringify(body) : undefined});
      return response.json();
    } },
  );
  return {
    service,
    taskWrites,
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
const approve = (f, expectedHeadSha = sha) => f.service.act(u, pid, id, { expectedRevision: 1, expectedHeadSha, action: "approve" });
test("final approval merges exact reviewed SHA and deployment start never merges again", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture(); // Existing unmerged deploy_pending recovers through approval.
    assert.equal((await approve(f)).status, "deploy_pending");
    assert.equal(f.task.mergeCommit, merged);
    assert.equal(f.attempts[0].status, "merged");
    assert.equal(JSON.parse(calls.find(c => c.url.endsWith("/merge")).options.body).sha, sha);
    await approve(f);
    assert.equal((await f.service.deploy(u, pid, { taskIds: [id] })).results[0].status, "deploying");
    await f.service.deploy(u, pid, { taskIds: [id] });
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 1);
  }));
test("partial reviewer approval never merges; final reviewer does not require deploy.run", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture();
    await f.tx.update(tasks).set({ status: "review_pending" });
    f.setReviewers([{ userId: u.id, status: "pending" }, { userId: other, status: "pending" }]);
    f.setPermissions(["tasks.read", "approvals.work"]);
    assert.equal((await approve(f)).status, "review_pending");
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 0);
    f.setReviewers([{ userId: u.id, status: "pending" }, { userId: other, status: "approved" }]);
    assert.equal((await approve(f)).status, "deploy_pending");
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 1);
  }));
test("stale reviewed code resets votes; stale confirmation SHA cannot approve", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture(); state.pr.head.sha = "d".repeat(40);
    assert.equal((await approve(f)).status, "in_progress");
    const staleUi = deployFixture(); state.pr.head.sha = sha;
    await assert.rejects(approve(staleUi, "e".repeat(40)), e => e.response.code === "REMOTE_CHANGED");
    assert.equal(f.reviewers[0].status, "pending");
    assert.equal(f.assigned[0].completedAt, null);
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 0);
  }));
test("conflict and network ambiguity remain in approval with retry; already merged PR is recovered", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture(); state.pr.mergeable = false;
    assert.equal((await approve(f)).mergeFailed, true);
    assert.equal(f.task.status, "review_pending");
    assert.equal(f.attempts[0].status, "failed");
    state.pr.mergeable = true; state.network = true;
    assert.equal((await approve(f)).mergeFailed, true);
    state.pr.merged = true; state.pr.merge_commit_sha = merged; state.pr.state = "closed";
    assert.equal((await approve(f)).mergeCommit, merged);
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 1);
  }));
test("deployment cannot merge legacy unmerged tasks", () => withGithub(async (state,calls) => {
  const f = deployFixture();
  assert.equal((await f.service.deploy(u,pid,{taskIds:[id]})).results[0].status,"failed");
  assert.equal(calls.length,0);
}));
test("mismatched base branch cannot be approved and no Github merge is called", () =>
  withGithub(async (state, calls) => {
    const f = deployFixture(); state.pr.base.ref = "production";
    await assert.rejects(approve(f), e => e.response.code === "PR_CHANGED");
    assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 0);
  }));
test("merged deploy_pending tasks and descendants cannot be reopened", async () => {
  const f=fixture({status:"deploy_pending",mergeCommit:merged});
  await assert.rejects(f.service.act(u,pid,id,{action:"changes_requested",expectedRevision:1,note:"change"}), e=>e.response.code==="NEW_REQUEST_REQUIRED");
  const ancestor=fixture({status:"done"}); ancestor.setDescendants([{...ancestor.task,id:other,status:"deploy_pending",mergeCommit:merged}]);
  await assert.rejects(ancestor.service.reset(ancestor.tx,ancestor.task,u.id,"change"),e=>e.response.code==="NEW_REQUEST_REQUIRED");
});
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


test("unfinished predecessor permits refresh but blocks completion and final approval", async () => {
  const f = fixture({ status: "todo" });
  f.service.ancestorTasks = async () => [{ id: other, status: "in_progress", completionMode: "document" }];
  assert.equal((await f.service.act(u, pid, id, { action: "refresh" })).status, "todo");
  await assert.rejects(
    f.service.act(u, pid, id, { action: "complete", expectedRevision: 1 }),
    e => e.response.code === "PREDECESSOR_REQUIRED",
  );
  assert.equal(f.assigned[0].completedAt, null);
  await assert.rejects(
    f.service.act(u, pid, id, { action: "approve", expectedRevision: 1 }),
    e => e.response.code === "PREDECESSOR_REQUIRED",
  );
  assert.equal(f.reviewers[0].status, "pending");
});

test("unfinished predecessor does not prevent a rework request", async () => {
  const f = fixture({ status: "review_pending" });
  f.service.ancestorTasks = async () => [{ id: other, status: "in_progress" }];
  assert.equal((await f.service.act(u, pid, id, {
    action: "changes_requested", expectedRevision: 1, note: "수정 필요",
  })).status, "in_progress");
});

test("predecessor rework leaves descendants actionable and invalidates previous approvals", async () => {
  for (const status of ["todo", "in_progress", "review_pending", "done", "deploy_pending"]) {
    const f = fixture({ status: "done" });
    f.service.descendants = async () => [{ id: other, status, workRevision: 3 }];
    await f.service.act(u, pid, id, {
      action: "changes_requested", expectedRevision: 1, note: "선행 수정",
    });
    const child = f.taskWrites.at(-1);
    assert.equal(child.status, status === "todo" ? "todo" : "in_progress");
    assert.equal(child.workRevision, 4);
    assert.equal(child.approvedHeadSha, "");
    assert.equal(f.events.at(-1).action, "predecessor_changed");
    assert.equal(f.events.at(-1).taskId, other);
  }
});

test("unfinished predecessor still prevents deployment", async () => {
  const f = deployFixture();
  await f.tx.update(tasks).set({ mergeCommit: merged });
  f.service.ancestorTasks = async () => [{ id: other, status: "in_progress" }];
  const result = await f.service.deploy(u, pid, { taskIds: [id] });
  assert.equal(result.results[0].status, "failed");
  assert.equal(result.results[0].error, "선행 업무 승인이 필요합니다.");
  assert.equal(f.task.status, "deploy_pending");
});

test("completion no longer requires separate result and verification fields", async () => {
  const f = fixture({ resultSummary: "", verification: "" });
  assert.equal((await f.service.act(u, pid, id, { action: "complete", expectedRevision: 1 })).status, "review_pending");
  assert.equal(f.reviewers.every(v => v.status === "pending"), true);
});


test("delayed unmerged PR webhook cannot invalidate merged deploy_pending", async () => {
  const f = fixture({ completionMode: "code", status: "deploy_pending", mergeCommit: merged, reviewHeadSha: sha });
  const result = await f.service.syncPullRequest({ repository: {html_url:f.task.repositoryUrl}, pull_request:{html_url:f.task.pullRequestUrl,head:{sha:"d".repeat(40)},state:"open"} });
  assert.equal(result.updated,0); assert.equal(f.task.status,"deploy_pending"); assert.equal(f.events.length,0);
});
test("verified CI deployment can release merged pending without manual deployment start", async () => {
  const f = fixture({ completionMode: "code", status: "deploy_pending", mergeCommit: merged, reviewHeadSha: sha, createdBy:u.id });
  await f.service.applyGitEvent({kind:"deployment", repository:f.task.repositoryUrl,branch:"main",commit:merged,url:"https://preview.example.test"});
  assert.equal(f.task.status,"released"); assert.equal(f.task.deploymentUrl,"https://preview.example.test");
});

test("code approval requires the exact SHA shown in confirmation", () => withGithub(async (state, calls) => {
  const f = deployFixture();
  await assert.rejects(f.service.act(u, pid, id, { action: "approve", expectedRevision: 1 }), e => e.response.code === "REMOTE_CHANGED");
  assert.equal(calls.filter(c => c.url.endsWith("/merge")).length, 0);
  assert.equal(f.attempts.length, 0);
}));


test("CI arriving during merge waits for locked task then uses committed merge SHA", async () => {
  const f = fixture({ completionMode: "code", status: "review_pending", mergeCommit: "", reviewHeadSha: sha, createdBy: u.id });
  const realTransaction = f.service.database.db.transaction;
  f.service.database.db.transaction = async fn => {
    await f.tx.update(tasks).set({ status: "deploy_pending", mergeCommit: merged });
    return realTransaction(fn);
  };
  const result = await f.service.applyGitEvent({ kind:"deployment", repository:f.task.repositoryUrl, branch:"main", commit:merged, url:"https://preview.example.test" });
  assert.equal(result.updated, 1); assert.equal(f.task.status, "released");
});
test("unmatched CI event does not claim a task was released", async () => {
  const f = fixture({ completionMode:"code", status:"deploy_pending", mergeCommit:merged, createdBy:u.id });
  assert.equal((await f.service.applyGitEvent({kind:"deployment",repository:f.task.repositoryUrl,branch:"main",commit:sha,url:"https://preview.example.test"})).updated,0);
  assert.equal(f.task.status,"deploy_pending");
});
