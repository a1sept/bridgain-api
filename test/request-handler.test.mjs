import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectWorkService } from "../dist/workspace/project-work.service.js";
import { ApprovalService } from "../dist/workspace/approval.service.js";
import { RequestsService } from "../dist/workspace/requests.service.js";
import { allProjectPermissions } from "../dist/workspace/project-roles.service.js";
import * as schema from "../dist/db/schema/index.js";
const pid = "00000000-0000-4000-8000-000000000001";
const rid = "00000000-0000-4000-8000-000000000002";
const mid = "00000000-0000-4000-8000-000000000003";
const oldMid = "00000000-0000-4000-8000-000000000004";
const user = {
  id: "00000000-0000-4000-8000-000000000005",
  displayName: "실제 처리자",
  accountType: "team",
};
const plan = { requestId: rid, planning: "업무 계획", assigneeIds: [user.id] };
const meeting = {
  id: mid,
  projectId: pid,
  title: "회의",
  decisionStatus: "draft",
  status: "scheduled",
  scheduledAt: new Date("2026-10-19T05:00:00Z"),
  durationMinutes: 60,
  location: "",
  notes: "",
};
function fixture({ existing = false, linked = false, invalid = false } = {}) {
  const pending = [],
    committed = [];
  const previous = existing && !linked ? [plan] : [];
  const chain = (rows) => {
    const q = {
      where: () => q,
      for: () => q,
      innerJoin: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return q;
  };
  const tx = {
    select: () => ({
      from(table) {
        if (table === schema.projectMeetings)
          return chain([linked ? { ...meeting, id: oldMid } : meeting]);
        if (table === schema.meetingRequests) return chain(previous);
        if (table === schema.projectRequests)
          return chain(invalid ? [] : [{ id: rid, projectId: pid }]);
        if (table === schema.requestWorkflowLinks)
          return chain(linked ? [{ requestId: rid, meetingId: oldMid }] : []);
        if (table === schema.projectMemberships)
          return chain([{ id: user.id, role: "contributor" }]);
        return chain([]);
      },
    }),
    insert: (table) => ({
      values(value) {
        pending.push({ table, value });
        return {
          ...chain([]),
          returning: () => chain([{ id: mid, ...value }]),
          onConflictDoUpdate: () => chain([]),
        };
      },
    }),
    update: (table) => ({
      set: (value) => ({
        where() {
          pending.push({ table, value });
          return {
            ...chain([]),
            returning: () => chain([{ ...meeting, ...value }]),
          };
        },
      }),
    }),
    delete: () => ({ where: () => chain([]) }),
  };
  const database = {
    db: {
      transaction: async (fn) => {
        try {
          const result = await fn(tx);
          committed.push(...pending);
          return result;
        } finally {
          pending.length = 0;
        }
      },
    },
  };
  const requests = {
    access: async () => ({
      isDeveloper: true,
      permissions: allProjectPermissions,
      canAssign: true,
    }),
  };
  const work = new ProjectWorkService(database, requests);
  work.access = async () => ({});
  work.links = async () => {
    if (invalid) throw Error("invalid request");
  };
  const approvals = new ApprovalService(database, requests);
  approvals.eligible = async () => [{ userId: user.id }];
  approvals.output = async (_tx, row) => row;
  return { work, approvals, committed, tx };
}
const handlers = (f) =>
  f.committed.filter(
    (w) =>
      w.table === schema.requestEvents && w.value.kind === "handler_assignment",
  );
test("saving a newly linked meeting records the authenticated actor instead of supplied handler data", async () => {
  const f = fixture();
  await f.work.saveMeeting(user, pid, {
    title: "회의",
    scheduledAt: "2026-10-19T05:00:00Z",
    requests: [plan],
    handlerId: oldMid,
  });
  assert.equal(handlers(f).length, 1);
  assert.equal(handlers(f)[0].value.actorId, user.id);
  assert.equal(handlers(f)[0].value.requestId, rid);
});
test("ordinary edits of an already linked meeting do not replace its request handler", async () => {
  const f = fixture({ existing: true });
  await f.work.saveMeeting(
    user,
    pid,
    { title: "제목 수정", requests: [plan] },
    mid,
  );
  assert.equal(handlers(f).length, 0);
});
test("confirmed transfer to a different meeting records the new actor", async () => {
  const f = fixture({ linked: true });
  await f.work.saveMeeting(user, pid, {
    title: "새 회의",
    scheduledAt: "2026-10-19T05:00:00Z",
    requests: [plan],
    transferFromMeetingIds: { [rid]: oldMid },
  });
  assert.equal(handlers(f).length, 1);
});
test("rejected meeting transfer and invalid saves commit no handler", async () => {
  const f = fixture({ linked: true });
  await assert.rejects(
    f.work.saveMeeting(user, pid, {
      title: "새 회의",
      scheduledAt: "2026-10-19T05:00:00Z",
      requests: [plan],
    }),
  );
  assert.equal(handlers(f).length, 0);
  const bad = fixture({ invalid: true });
  await assert.rejects(
    bad.work.saveMeeting(user, pid, { title: "회의", requests: [plan] }),
  );
  assert.equal(handlers(bad).length, 0);
});
test("successful urgent submission records its actor; failed validation records nobody", async () => {
  const f = fixture();
  await f.approvals.create(user, pid, {
    source: "urgent",
    approverIds: [user.id],
    plans: [plan],
    handlerId: oldMid,
  });
  assert.equal(handlers(f).length, 1);
  assert.equal(handlers(f)[0].value.actorId, user.id);
  const bad = fixture({ invalid: true });
  await assert.rejects(
    bad.approvals.create(user, pid, {
      source: "urgent",
      approverIds: [user.id],
      plans: [plan],
    }),
  );
  assert.equal(handlers(bad).length, 0);
});
test("request projection keeps the processing handler separate from work assignees", async () => {
  const seen = [];
  const rows = [
    [{ name: "요청자" }],
    [{ userId: user.id, displayName: user.displayName, handledAt: new Date() }],
    [],
    [{ userId: oldMid, displayName: "업무 담당자" }],
    [],
    [],
  ];
  const tx = {
    select() {
      const result = rows.shift();
      const q = {
        from: (table) => {
          seen.push(table);
          return q;
        },
        where: () => q,
        innerJoin: () => q,
        orderBy: () => q,
        limit: () => q,
        then: (resolve) => Promise.resolve(result).then(resolve),
      };
      return q;
    },
  };
  const service = new RequestsService({ db: {} });
  const result = await service.output(tx, { id: rid, projectId: pid });
  assert.equal(result.handler.userId, user.id);
  assert.deepEqual(
    result.assignees.map((p) => p.userId),
    [oldMid],
  );
  assert.ok(seen.includes(schema.requestEvents));
});
