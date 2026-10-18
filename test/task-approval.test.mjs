import { allProjectPermissions } from "../dist/workspace/project-roles.service.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalService } from "../dist/workspace/approval.service.js";
import { RequestsService } from "../dist/workspace/requests.service.js";
import * as schema from "../dist/db/schema/index.js";
const id = "abcdef01-1234-4321-abcd-123456789012";
function fixture(rows) {
  const writes = [];
  const query = (value) => ({
    from() {
      return this;
    },
    innerJoin() {
      return this;
    },
    where() {
      return this;
    },
    for() {
      return this;
    },
    orderBy() {
      return this;
    },
    then(resolve) {
      return Promise.resolve(value).then(resolve);
    },
  });
  const tx = {
    select: () => query(rows.shift()),
    update: (table) => ({
      set: (value) => ({
        where: () => {
          writes.push({ table, value });
          return { ...query([]), returning: () => query(rows.shift()) };
        },
      }),
    }),
    insert: (table) => ({
      values: (value) => {
        writes.push({ table, value });
        return {
          returning: () => query([{ id, ...value }]),
          onConflictDoUpdate: () => query([]),
        };
      },
    }),
  };

  const database = { db: { transaction: (fn) => fn(tx) } };
  const service = new ApprovalService(database, {
    access: async () => ({
      isDeveloper: true,
      permissions: [...allProjectPermissions],
      canApproveTasks: true,
      canAssign: false,
    }),
  });
  return { service, database, writes };
}
const user = { id, displayName: "Dev", accountType: "team" };
const approval = {
  id,
  projectId: id,
  requestedBy: id,
  source: "urgent",
  title: "Review",
  status: "pending",
  plans: [{ requestId: id, planning: "Plan", assigneeIds: [id] }],
};
const eligible = [
  {
    userId: id,
    displayName: "Dev",
    canApproveTasks: true,
    role: "member",
    accessRole: "contributor",
  },
];
test("first explicit approval leaves multi-approver request pending and creates no task", async () => {
  const f = fixture([
    [approval],
    eligible,
    [{ userId: id, status: "pending" }],
    [
      { userId: id, status: "approved" },
      { userId: "other", status: "pending" },
    ],
    [{ ...approval }],
    [
      { userId: id, displayName: "Dev", status: "approved" },
      { userId: "other", status: "pending" },
    ],
    [{ name: "Project" }],
    [{ displayName: "Dev" }],
    [{ id, title: "Request", origin: "development" }],
    eligible,
  ]);
  const result = await f.service.act(user, id, id, { action: "approve" });
  assert.equal(result.approval.status, "pending");
  assert.equal(
    f.writes.some((x) => x.table === schema.projectTasks),
    false,
  );
  assert.equal(
    f.writes.find((x) => x.table === schema.taskApprovalReviewers).value.status,
    "approved",
  );
});
test("cancel preserves meeting ownership while clearing pending approval link", async () => {
  const f = fixture([
    [approval],
    [{ ...approval, status: "cancelled" }],
    [],
    [{ name: "P" }],
    [{ displayName: "D" }],
    [{ id, title: "R" }],
    eligible,
  ]);
  await f.service.act(user, id, id, { action: "cancel" });
  const unlock = f.writes.find((x) => x.table === schema.requestWorkflowLinks);
  assert.deepEqual(unlock.value, { approvalId: null });
  assert.equal(
    f.writes.some((x) => x.table === schema.projectTasks),
    false,
  );
});
test("closed approvals cannot produce tasks on retry", async () => {
  const f = fixture([[{ ...approval, status: "approved" }]]);
  await assert.rejects(
    f.service.act(user, id, id, { action: "approve" }),
    (e) => e.getResponse().code === "APPROVAL_CLOSED",
  );
  assert.equal(f.writes.length, 0);
});
test("revoked earlier approver prevents final conversion atomically", async () => {
  const f = fixture([
    [approval],
    eligible,
    [{ userId: id, status: "pending" }],
    [
      { userId: id, status: "approved" },
      { userId: "revoked", status: "approved" },
    ],
    eligible,
    [{ userId: id }, { userId: "revoked" }],
  ]);
  await assert.rejects(
    f.service.act(user, id, id, { action: "approve" }),
    (e) => e.getResponse().code === "APPROVER_CHANGED",
  );
  assert.equal(
    f.writes.some((x) => x.table === schema.projectTasks),
    false,
  );
});
test("guessed development request IDs are hidden from customer detail, comments and files", async () => {
  for (const method of ["detail", "comment", "download", "upload"]) {
    const f = fixture([
      [{ id, projectId: id, origin: "development", createdBy: "developer" }],
    ]);
    const service = new RequestsService(f.database);
    service.access = async () => ({ isDeveloper: false });
    const args =
      method === "comment"
        ? [{ body: "comment" }]
        : method === "download"
          ? [id]
          : method === "upload"
            ? [
                [
                  {
                    originalname: "a.pdf",
                    mimetype: "application/pdf",
                    buffer: Buffer.from("%PDF-test"),
                    size: 9,
                  },
                ],
              ]
            : [];
    await assert.rejects(
      service[method]({ id: "client", accountType: "client" }, id, id, ...args),
      (e) => e.getStatus() === 404,
    );
    assert.equal(f.writes.length, 0);
  }
});

test("configured roles cannot submit assigned approval plans without task assignment permission", async () => {
  const service = new ApprovalService(
    {
      db: {
        transaction: (fn) =>
          fn(
            new Proxy(
              {},
              {
                get() {
                  throw Error("Unexpected data access");
                },
              },
            ),
          ),
      },
    },
    {
      access: async () => ({
        isDeveloper: true,
        rolesConfigured: true,
        permissions: ["requests.read", "requests.create"],
      }),
    },
  );
  await assert.rejects(
    service.create(user, id, { source: "urgent" }),
    (e) => e.getStatus() === 403,
  );
});
