import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRepositories } from "../dist/workspace/project-repositories.js";
import { WorkspaceService } from "../dist/workspace/workspace.service.js";

test("repository registration accepts skipping and normalizes clone URLs", () => {
  assert.deepEqual(projectRepositories([]), []);
  assert.deepEqual(
    projectRepositories([
      " https://github.com/Team/frontend.git/ ",
      "https://github.com/Team/api",
    ]),
    ["https://github.com/Team/frontend", "https://github.com/Team/api"],
  );
});

test("repository registration rejects credentials, foreign hosts, extra paths and duplicates", () => {
  for (const value of [
    null,
    "https://github.com/a/b",
    [null],
    ["https://github.com/a/b", "https://github.com/A/B.git/"],
    ["http://github.com/a/b"],
    ["https://github.com.evil.test/a/b"],
    ["https://token@github.com/a/b"],
    ["https://github.com/a/b?token=secret"],
    ["https://github.com/a/b/tree/main"],
    ["https://github.com/a/.."],
    Array(21).fill("https://github.com/a/b"),
  ]) {
    assert.throws(
      () => projectRepositories(value),
      (e) => e.getStatus?.() === 400,
    );
  }
});

test("clients cannot create projects or change repository registration", async () => {
  const service = new WorkspaceService({
    get db() {
      throw Error("Unexpected DB access");
    },
  });
  const client = {
    id: "00000000-0000-4000-8000-000000000001",
    accountType: "client",
  };
  await assert.rejects(
    service.create(client, { name: "test" }),
    (e) => e.getStatus?.() === 403,
  );
  await assert.rejects(
    service.update(client, client.id, { repositoryUrls: [] }),
    (e) => e.getStatus?.() === 403,
  );
});

test("project update persists normalized repositories only after manager check", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  let patch;
  const registrationQueries = [];
  let role = "owner";
  let count = 0;
  const tx = {
    execute: async (query) => {
      registrationQueries.push(query);
      return { rows: [] };
    },
    select: () => {
      const q = {
        innerJoin: () => q,
        where: () => q,
        for: () => q,
        then: (resolve) => {
          const rows = [
            [{ id, teamId: id }],
            [],
            [{ permissionRole: role }],
            [{ userId: id }],
            [{ role: "contributor", teamId: id, rolesConfigured: false }],
            [{ permissionRole: role }],
            [],
            [{ id, teamId: id, repositoryUrls: [], repositoryRelations: [] }],
          ][count++];
          return Promise.resolve(rows).then(resolve);
        },
      };
      return { from: () => q };
    },
    update: () => ({
      set: (value) => {
        patch = value;
        return { where: () => ({ returning: async () => [{ id, ...value }] }) };
      },
    }),
  };
  const service = new WorkspaceService({ db: { transaction: (fn) => fn(tx) } });
  const actor = { id, accountType: "team" };
  const result = await service.update(actor, id, {
    repositoryUrls: ["https://github.com/a/b.git"],
    registeredBy: "spoofed-user",
    managerUserId: "spoofed-user",
  });
  assert.deepEqual(result.repositoryUrls, ["https://github.com/a/b"]);
  const { PgDialect } = await import("drizzle-orm/pg-core");
  assert.deepEqual(new PgDialect().sqlToQuery(registrationQueries[0]).params, [
    id,
    "https://github.com/a/b",
    id,
  ]);
  count = 0;
  await service.update(actor, id, { name: "Rename" });
  assert.equal(Object.hasOwn(patch, "repositoryUrls"), false);
  count = 0;
  await service.update(actor, id, { repositoryUrls: [] });
  assert.deepEqual(patch.repositoryUrls, []);
  count = 0;
  role = "member";
  patch = undefined;
  await assert.rejects(
    service.update(actor, id, { repositoryUrls: [] }),
    (e) => e.getStatus?.() === 403,
  );
  assert.equal(patch, undefined);
});
