import { allProjectPermissions } from "../dist/workspace/project-roles.service.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskReviewService } from "../dist/workspace/task-review.service.js";
import { ProjectWorkService } from "../dist/workspace/project-work.service.js";
import { requireApprovedReview } from "../dist/workspace/merge-review-policy.js";
import {
  checkPullRequest,
  pullRequestPath,
} from "../dist/workspace/github-pull-request.js";
import {
  projectTasks,
  taskAssignees,
  taskReviewEvents,
  taskResultEntries,
} from "../dist/db/schema/project-work.js";
import {
  projectMemberships,
  teamMemberships,
} from "../dist/db/schema/workspace.js";
const pid = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const dev = {
  id: "00000000-0000-4000-8000-000000000003",
  displayName: "Developer",
  accountType: "team",
};
const reviewer = {
  id: "00000000-0000-4000-8000-000000000004",
  displayName: "Reviewer",
  accountType: "team",
};
const repo = "https://github.com/example/project";
const sha = "a".repeat(40),
  base = "b".repeat(40),
  mergedSha = "c".repeat(40);
function fixture(overrides = {}) {
  let task = {
    id,
    projectId: pid,
    version: id,
    title: "Task",
    description: "",
    priority: "normal",
    dueDate: null,
    status: "in_progress",
    repositoryUrl: repo,
    workBranch: "feature/work",
    liveBranch: "main",
    pullRequestUrl: repo + "/pull/1",
    mergeCommit: "",
    deploymentUrl: null,
    resultSummary: "Implemented",
    verification: "Tests passed",
    dbChanges: "",
    apiChanges: "",
    frontendChanges: "",
    createdBy: dev.id,
    mergeApprovalRequired: true,
    mergeReviewerId: reviewer.id,
    reviewStatus: "none",
    reviewHeadSha: "",
    reviewBaseSha: "",
    reviewRequestedBy: null,
    reviewRequestId: id,
    ...overrides,
  };
  const events = [],
    resultEntries = [],
    calls = [];
  const state = {
    allowed: true,
    isDeveloper: true,
    permissions: [...allProjectPermissions],
    canApproveTasks: true,
    canAssign: false,
    saves: 0,
    protectedTasks: [],
  };
  const pr = {
    html_url: task.pullRequestUrl,
    state: "open",
    draft: false,
    merged: false,
    merge_commit_sha: null,
    head: { sha, ref: "feature/work", repo: { html_url: repo } },
    base: { sha: base, ref: "main", repo: { html_url: repo } },
  };
  const chain = (fn) => {
    const value = {
      then: (resolve, reject) =>
        Promise.resolve().then(fn).then(resolve, reject),
    };
    for (const name of ["innerJoin", "where", "for", "orderBy", "limit"])
      value[name] = () => value;
    return value;
  };
  const tx = {
    execute: async () => {},
    select: (fields) => ({
      from: (table) =>
        chain(() => {
          if (table === projectTasks)
            return fields?.id ? state.protectedTasks : [task];
          if (table === taskAssignees) return [{ userId: dev.id, taskId: id }];
          if (table === teamMemberships)
            return [
              { permissionRole: "member", canApproveMerge: state.allowed },
            ];
          if (table === projectMemberships)
            return [
              {
                id: reviewer.id,
                accountType: "team",
                status: "active",
                role: "developer",
                allowed: state.allowed,
              },
            ];
          return [];
        }),
    }),
    update: (table) => ({
      set: (values) => {
        const q = chain(() => {
          if (table === projectTasks) task = { ...task, ...values };
          return [task];
        });
        q.returning = () => q;
        return q;
      },
    }),
    insert: (table) => ({
      values: (values) => {
        const q = chain(() => {
          if (table === taskReviewEvents) events.push(values);
          if (table === taskResultEntries) {
            resultEntries.push(values);
            return [values];
          }
          return [];
        });
        q.returning = () => q;
        return q;
      },
    }),
    delete: () => ({ where: async () => {} }),
  };
  const database = {
    db: {
      select: tx.select,
      transaction: async (fn) => {
        const previous = { ...task },
          eventCount = events.length;
        try {
          return await fn(tx);
        } catch (error) {
          task = previous;
          events.length = eventCount;
          throw error;
        }
      },
    },
  };
  const requests = {
    access: async () => ({
      isDeveloper: state.isDeveloper,
      permissions: state.permissions ?? [...allProjectPermissions],
      canAssign: state.canAssign,
    }),
  };
  const work = new ProjectWorkService(database, requests);
  work.taskOutput = async (_, row) => ({
    ...row,
    assigneeIds: [dev.id],
    requestIds: [],
  });
  work.links = async () => {};
  work.event = async () => {};
  work.syncRequests = async () => {};
  const service = new TaskReviewService(database, requests, work);
  return {
    service,
    work,
    pr,
    calls,
    events,
    resultEntries,
    state,
    task: () => task,
    tx,
  };
}
async function usingGithub(
  f,
  run,
  mergeResponse = { merged: true, sha: mergedSha },
) {
  const originalFetch = globalThis.fetch;
  const token = process.env.GITHUB_MERGE_TOKEN,
    mapping = process.env.GITHUB_PROJECT_REPOSITORIES;
  process.env.GITHUB_MERGE_TOKEN = "test-only";
  process.env.GITHUB_PROJECT_REPOSITORIES = JSON.stringify({ [pid]: [repo] });
  globalThis.fetch = async (url, options) => {
    f.calls.push({ url, options });
    return new Response(
      JSON.stringify(options.method === "PUT" ? mergeResponse : f.pr),
      {
        status: mergeResponse === null && options.method === "PUT" ? 409 : 200,
      },
    );
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.GITHUB_MERGE_TOKEN;
    else process.env.GITHUB_MERGE_TOKEN = token;
    if (mapping === undefined) delete process.env.GITHUB_PROJECT_REPOSITORIES;
    else process.env.GITHUB_PROJECT_REPOSITORIES = mapping;
  }
}
const act = (f, user, action, note = "") =>
  f.service.act(user, pid, id, {
    action,
    note,
    expectedReviewId: f.task().reviewRequestId,
  });
const rejects = (promise, status) =>
  assert.rejects(promise, (e) => e.getStatus?.() === status);

test("request, named reviewer approval, SHA-bound merge and completion form one workflow", async () => {
  const f = fixture();
  await usingGithub(f, async () => {
    assert.equal((await act(f, dev, "request")).status, "pending");
    assert.equal(f.task().reviewHeadSha, sha);
    assert.equal(f.task().reviewBaseSha, base);
    assert.equal(f.task().reviewRequestedBy, dev.id);
    await rejects(act(f, dev, "approve"), 403);
    await act(f, reviewer, "approve", "Reviewed");
    assert.equal(f.task().status, "in_progress");
    assert.equal((await act(f, dev, "merge")).status, "done");
    assert.equal(f.task().status, "done");
    assert.equal(f.task().mergeCommit, mergedSha);
    const writes = f.calls.filter((c) => c.options.method === "PUT");
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].options.body), {
      sha,
      merge_method: "merge",
    });
    assert.deepEqual(
      f.events.map((e) => e.action),
      ["requested", "approved", "merged"],
    );
    await act(f, dev, "merge");
    assert.equal(f.calls.filter((c) => c.options.method === "PUT").length, 1);
  });
});
test("changed PR head or base invalidates approval without merging", async () => {
  for (const key of ["head", "base"]) {
    const f = fixture();
    await usingGithub(f, async () => {
      await act(f, dev, "request");
      await act(f, reviewer, "approve");
      f.pr[key].sha = "d".repeat(40);
      assert.equal((await act(f, dev, "merge")).status, "stale");
      assert.equal(f.task().reviewStatus, "stale");
      assert.equal(f.task().status, "in_progress");
      assert.equal(
        f.calls.some((c) => c.options.method === "PUT"),
        false,
      );
      await act(f, dev, "request");
      await act(f, reviewer, "approve");
      assert.equal(f.task().reviewHeadSha, f.pr.head.sha);
    });
  }
});
test("changes requested needs a reason, prevents merge, and supports resubmission", async () => {
  const f = fixture();
  await usingGithub(f, async () => {
    await act(f, dev, "request");
    await rejects(act(f, reviewer, "changes_requested"), 400);
    await act(f, reviewer, "changes_requested", "Add regression coverage");
    await rejects(act(f, dev, "merge"), 409);
    assert.equal(
      f.calls.some((c) => c.options.method === "PUT"),
      false,
    );
    await act(f, dev, "request");
    await act(f, reviewer, "approve");
    assert.equal(f.task().reviewStatus, "approved");
  });
});
test("revoked reviewer, client access, and self review cannot trigger GitHub mutations", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  await usingGithub(f, async () => {
    f.state.allowed = false;
    await rejects(act(f, dev, "merge"), 403);
    f.state.isDeveloper = false;
    await rejects(act(f, dev, "request"), 403);
    assert.equal(f.calls.length, 0);
  });
  const self = fixture({ mergeReviewerId: dev.id });
  await usingGithub(self, async () => {
    await rejects(act(self, dev, "request"), 409);
    assert.equal(self.calls.length, 0);
  });
});
test("GitHub merge rejection preserves approved/in-progress state", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  await usingGithub(
    f,
    async () => {
      await rejects(act(f, dev, "merge"), 409);
      assert.equal(f.task().status, "in_progress");
      assert.equal(f.task().reviewStatus, "approved");
      assert.equal(f.events.length, 0);
    },
    null,
  );
});
test("retry after a remote merge succeeds recovers local completion without merging twice", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  f.pr.merged = true;
  f.pr.state = "closed";
  f.pr.merge_commit_sha = mergedSha;
  await usingGithub(f, async () => {
    assert.equal((await act(f, dev, "merge")).status, "done");
    assert.equal(
      f.calls.some((c) => c.options.method === "PUT"),
      false,
    );
  });
});
test("ordinary task updates cannot disable approval or forge development completion", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  await rejects(
    f.work.saveTask(dev, pid, { mergeApprovalRequired: false }, id),
    403,
  );
  await rejects(
    f.work.saveTask(dev, pid, { status: "done", mergeCommit: mergedSha }, id),
    409,
  );
  await rejects(
    f.work.saveTask(dev, pid, { status: "done", mergeCommit: mergedSha }, id, {
      kind: "merge",
      repository: repo,
      branch: "main",
      workBranch: "feature/work",
      headSha: "d".repeat(40),
      commit: mergedSha,
      url: repo + "/pull/1",
    }),
    409,
  );
  assert.equal(f.task().status, "in_progress");
});
test("changing reviewed results invalidates approval and preserves an audit record", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  await f.work.saveTask(dev, pid, { resultSummary: "Changed scope" }, id);
  assert.equal(f.task().reviewStatus, "none");
  assert.equal(f.task().reviewHeadSha, "");
  assert.equal(f.events[0].action, "invalidated");
});
test("integration requires exact project repository allowlist and valid same-repo PR", async () => {
  const f = fixture();
  await usingGithub(f, async () => {
    assert.equal(
      pullRequestPath(pid, repo, repo + "/pull/1"),
      "/repos/example/project/pulls/1",
    );
    assert.throws(() =>
      pullRequestPath("another-project", repo, repo + "/pull/1"),
    );
    assert.throws(() => pullRequestPath(pid, repo, "https://evil.test/pull/1"));
    assert.throws(() => pullRequestPath(pid, repo, repo + "/pull/1?token=bad"));
    assert.throws(() => checkPullRequest({ ...f.pr, draft: true }, f.task()));
    assert.throws(() =>
      checkPullRequest(
        {
          ...f.pr,
          head: {
            ...f.pr.head,
            repo: { html_url: "https://github.com/other/fork" },
          },
        },
        f.task(),
      ),
    );
    assert.throws(() =>
      requireApprovedReview(
        { reviewStatus: "pending", reviewHeadSha: sha, reviewBaseSha: base },
        sha,
        base,
      ),
    );
  });
});

test("a reviewer viewing a previous request cannot approve a new request with the same commit", async () => {
  const f = fixture();
  await usingGithub(f, async () => {
    await act(f, dev, "request");
    const previousReviewId = f.task().reviewRequestId;
    await act(f, dev, "request");
    assert.notEqual(f.task().reviewRequestId, previousReviewId);
    await rejects(
      f.service.act(reviewer, pid, id, {
        action: "approve",
        expectedReviewId: previousReviewId,
      }),
      409,
    );
    assert.equal(f.task().reviewStatus, "pending");
  });
});

test("tasks without required approval allow the assignee to merge the current PR directly", async () => {
  const f = fixture({ mergeApprovalRequired: false, mergeReviewerId: null });
  await usingGithub(f, async () => {
    await rejects(act(f, reviewer, "merge"), 403);
    assert.equal((await act(f, dev, "merge")).status, "done");
    assert.equal(
      JSON.parse(f.calls.find((c) => c.options.method === "PUT").options.body)
        .sha,
      sha,
    );
  });
});

test("an unguarded task cannot bypass another task's required approval for the same PR", async () => {
  const f = fixture({ mergeApprovalRequired: false, mergeReviewerId: null });
  f.state.protectedTasks = [{ id: reviewer.id }];
  await usingGithub(f, async () => {
    await rejects(act(f, dev, "merge"), 409);
    assert.equal(f.calls.length, 0);
    assert.equal(f.task().status, "in_progress");
  });
});

test("GitHub PR change webhooks invalidate a pending review without a GitHub request", async () => {
  const f = fixture({
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
    reviewRequestedBy: dev.id,
  });
  const payload = {
    action: "synchronize",
    repository: { html_url: repo },
    pull_request: {
      ...f.pr,
      head: { ...f.pr.head, sha: "d".repeat(40) },
    },
  };
  assert.equal((await f.service.syncPullRequest(payload)).updated, 1);
  assert.equal(f.task().reviewStatus, "stale");
  assert.equal(f.events[0].action, "stale");
  assert.equal((await f.service.syncPullRequest(payload)).updated, 0);
});

test("deployment preserves approved results and does not require a former reviewer to remain active", async () => {
  const f = fixture({
    status: "done",
    mergeCommit: mergedSha,
    reviewStatus: "approved",
    reviewHeadSha: sha,
    reviewBaseSha: base,
  });
  f.state.allowed = false;
  await rejects(
    f.work.saveTask(
      dev,
      pid,
      {
        status: "released",
        deploymentUrl: "https://deploy.example/1",
        resultSummary: "Unreviewed replacement",
      },
      id,
    ),
    409,
  );
  await f.work.saveTask(
    dev,
    pid,
    { status: "released", deploymentUrl: "https://deploy.example/1" },
    id,
  );
  assert.equal(f.task().status, "released");
});

test("stale task forms cannot overwrite a newer human or AI result", async () => {
  const f = fixture();
  const version = f.task().version;
  await f.work.saveTask(
    dev,
    pid,
    { expectedVersion: version, resultSummary: "New AI result" },
    id,
  );
  assert.notEqual(f.task().version, version);
  await rejects(
    f.work.saveTask(
      dev,
      pid,
      {
        expectedVersion: version,
        resultSummary: "Stale screen",
        description: "Other edit",
      },
      id,
    ),
    409,
  );
  assert.equal(f.task().resultSummary, "New AI result");
  await f.work.saveTask(
    dev,
    pid,
    { expectedVersion: f.task().version, resultSummary: "New AI result" },
    id,
  );
  assert.equal(f.task().resultSummary, "New AI result");
});
test("review transitions invalidate older task edit versions", async () => {
  const f = fixture();
  const version = f.task().version;
  await usingGithub(f, async () => {
    await act(f, dev, "request");
    await rejects(
      f.work.saveTask(
        dev,
        pid,
        { expectedVersion: version, description: "Old form" },
        id,
      ),
      409,
    );
    assert.equal(f.task().reviewStatus, "pending");
  });
});
test("completed and deployed tasks accept append-only result records without reopening or changing approval", async () => {
  for (const status of ["done", "released"]) {
    const f = fixture({
      status,
      reviewStatus: "approved",
      mergeCommit: mergedSha,
    });
    const original = { ...f.task() };
    await f.work.appendResult(dev, pid, id, {
      expectedVersion: original.version,
      changeSummary: "DB design explanation",
      dbChanges: "Indexes documented",
    });
    await f.work.appendResult(reviewer, pid, id, {
      expectedVersion: original.version,
      changeSummary: "API follow-up",
      apiChanges: "Response format documented",
    });
    assert.deepEqual(f.task(), original);
    assert.equal(f.resultEntries.length, 2);
    assert.equal(f.resultEntries[0].actorId, dev.id);
    assert.equal(f.resultEntries[1].actorId, reviewer.id);
    await rejects(
      f.work.appendResult(dev, pid, id, {
        expectedVersion: reviewer.id,
        changeSummary: "Stale",
      }),
      409,
    );
    await rejects(
      f.work.appendResult(dev, pid, id, {
        expectedVersion: original.version,
        changeSummary: "",
      }),
      400,
    );
    assert.equal(f.resultEntries.length, 2);
  }
});
test("result records reject projects without access and unfinished tasks", async () => {
  const f = fixture();
  await rejects(
    f.work.appendResult(dev, pid, id, {
      expectedVersion: f.task().version,
      changeSummary: "Not finished",
    }),
    409,
  );
  f.state.isDeveloper = false;
  await rejects(
    f.work.appendResult(dev, pid, id, {
      expectedVersion: f.task().version,
      changeSummary: "Forbidden",
    }),
    403,
  );
  assert.equal(f.resultEntries.length, 0);
});

test("a designated merge reviewer may merge without assignee progress rights", async () => {
  const f = fixture();
  await usingGithub(f, async () => {
    await act(f, dev, "request");
    f.state.permissions = ["tasks.read", "approvals.merge"];
    await act(f, reviewer, "approve", "Reviewed");
    assert.equal((await act(f, reviewer, "merge")).status, "done");
  });
});
