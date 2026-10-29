import { allProjectPermissions } from "../dist/workspace/project-roles.service.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectWorkService } from "../dist/workspace/project-work.service.js";
import { ProjectWorkController } from "../dist/workspace/project-work.controller.js";
import {
  projectTasks,
  projectMeetings,
  meetingRequests,
} from "../dist/db/schema/project-work.js";
const id = "00000000-0000-4000-8000-000000000001";
const user = { id, accountType: "team", displayName: "Dev" };
const chain = (fn) => {
  const q = {
    then: (resolve, reject) => Promise.resolve().then(fn).then(resolve, reject),
  };
  for (const name of ["where", "for", "returning", "innerJoin", "orderBy"])
    q[name] = () => q;
  return q;
};
test("HTTP task updates require a version after authentication", async () => {
  let saved = 0,
    authenticated = 0;
  const controller = new ProjectWorkController(
    {
      user: async () => {
        authenticated++;
        return user;
      },
    },
    {
      saveTask: async (...args) => {
        saved++;
        assert.equal(args[2].expectedVersion, id);
      },
    },
    {},
  );
  await assert.rejects(
    controller.updateTask({}, {}, id, id, { title: "Old client" }),
    (e) => e.getStatus() === 409,
  );
  assert.equal(authenticated, 1);
  assert.equal(saved, 0);
  await controller.updateTask({}, {}, id, id, { expectedVersion: id });
  assert.equal(saved, 1);
});
test("final meeting completion is idempotent and preserves decisions and linked tasks", async () => {
  let meeting = {
    id,
    decisionStatus: "final",
    status: "in_progress",
    title: "Final meeting",
    notes: "Agreed scope",
  };
  const plans = [{ requestId: id, taskId: id, planning: "Agreed plan" }];
  let writes = 0,
    events = 0;
  const tx = {
    select: () => ({
      from: (table) =>
        chain(() =>
          table === projectMeetings
            ? [meeting]
            : table === meetingRequests
              ? plans
              : [],
        ),
    }),
    update: (table) => ({
      set: (changes) =>
        chain(() => {
          assert.equal(table, projectMeetings);
          meeting = { ...meeting, ...changes };
          writes++;
          return [meeting];
        }),
    }),
    insert: () => { throw Error("Must not duplicate assigned tasks"); },
    delete: () => {
      throw Error("Must not rebuild final request plans");
    },
  };
  const service = new ProjectWorkService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({
        isDeveloper: true,
        permissions: [...allProjectPermissions],
      }),
    },
  );
  service.event = async () => {
    events++;
  };
  const result = await service.meetingAction(user,id,id,{action:"complete"});
  assert.equal(result.meeting.status, "completed");
  assert.deepEqual(plans, [{ requestId: id, taskId: id, planning: "Agreed plan" }]);
  await service.meetingAction(user,id,id,{action:"complete"});
  assert.equal(writes, 1);
  assert.equal(events, 1);
  for (const body of [
    { status: "scheduled" },
    { status: "completed", notes: "Changed scope" },
    { title: "Overwrite" },
  ])
    await assert.rejects(
      service.saveMeeting(user, id, body, id),
      (e) => e.getStatus() === 409,
    );
  assert.equal(meeting.notes, "Agreed scope");
});
test("a rejected Git task is audited without blocking later matching tasks", async () => {
  const rows = ["blocked", "valid"].map((taskId) => ({
    id: taskId,
    projectId: id,
    liveBranch: "main",
    workBranch: "feature",
    status: "in_progress",
    resultSummary: "Implemented",
  }));
  const db = {
    select: () => ({
      from: (table) => chain(() => (table === projectTasks ? rows : [user])),
    }),
    transaction: (fn) => fn({}),
  };
  const service = new ProjectWorkService({ db }, {});
  const attempted = [],
    events = [];
  service.saveTask = async (u, p, b, taskId) => {
    attempted.push(taskId);
    if (taskId === "blocked")
      throw Object.assign(Error("Approval"), {
        getStatus: () => 409,
        getResponse: () => ({ code: "MERGE_APPROVAL_REQUIRED" }),
      });
    return { ignored: false };
  };
  service.event = async (...args) => {
    events.push(args);
  };
  const result = await service.applyGitEvent({
    kind: "merge",
    repository: "https://github.com/example/repo",
    branch: "main",
    workBranch: "feature",
    commit: "a".repeat(40),
    url: "https://github.com/example/repo/pull/1",
  });
  assert.deepEqual(attempted, ["blocked", "valid"]);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.failed, [
    { taskId: "blocked", code: "MERGE_APPROVAL_REQUIRED" },
  ]);
  assert.equal(events[0][4], "git_sync_failed");
});
