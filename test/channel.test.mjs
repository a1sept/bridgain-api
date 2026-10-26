import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChannelService,
  channelVisibility,
} from "../dist/workspace/channel.service.js";
const pid = "00000000-0000-4000-8000-000000000001";
const user = {
  id: "00000000-0000-4000-8000-000000000002",
  displayName: "팀원",
  accountType: "team",
};
test("internal channel rejects customers even when permission strings are present", () => {
  assert.throws(
    () =>
      channelVisibility(false, [
        "tasks.read",
        "meetings.read",
        "requests.read",
      ]),
    (e) => e.getStatus() === 403,
  );
  assert.deepEqual(channelVisibility(true, []), {
    task: false,
    meeting: false,
    approval: false,
  });
  assert.equal(
    channelVisibility(true, ["tasks.read", "meetings.read"]).approval,
    false,
  );
});
test("channel verifies membership before reading or posting and rejects empty messages", async () => {
  let queries = 0;
  const tx = {
    execute() {
      queries++;
      throw Error("must not query");
    },
  };
  const service = new ChannelService(
    { db: { transaction: (fn) => fn(tx) } },
    { access: async () => ({ isDeveloper: false, permissions: [] }) },
  );
  await assert.rejects(service.list(user, pid), (e) => e.getStatus() === 403);
  await assert.rejects(
    service.post(user, pid, { body: "private" }),
    (e) => e.getStatus() === 403,
  );
  await assert.rejects(
    service.post(user, pid, { body: "  " }),
    (e) => e.getStatus() === 400,
  );
  assert.equal(queries, 0);
});
test("channel rejects missing parent and cross-project task before inserting", async () => {
  let writes = 0;
  const tx = {
    execute: async () => ({ rows: [] }),
    insert() {
      writes++;
      throw Error("must not insert");
    },
  };
  const service = new ChannelService(
    { db: { transaction: (fn) => fn(tx) } },
    {
      access: async () => ({ isDeveloper: true, permissions: ["tasks.read"] }),
    },
  );
  await assert.rejects(
    service.post(user, pid, { body: "reply", parentKey: "message:missing" }),
    (e) => e.getStatus() === 404,
  );
  await assert.rejects(
    service.post(user, pid, { body: "task", taskId: pid }),
    (e) => e.getStatus() === 404,
  );
  assert.equal(writes, 0);
});
