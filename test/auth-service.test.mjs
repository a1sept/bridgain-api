import assert from "node:assert/strict";
import { test } from "node:test";
import * as argon2 from "argon2";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuthService } from "../dist/auth/auth.service.js";
import {
  users,
  passwordCredentials,
  authSessions,
} from "../dist/db/schema/auth.js";
import { digest } from "../dist/auth/security.js";
const account = {
  id: "user-1",
  email: "user@example.com",
  displayName: "Tester",
  accountType: "client",
  status: "active",
  emailVerifiedAt: null,
};
const password = "a secure test password";
test("signup writes only an account and Argon2id credential without verifying email or issuing tokens", async () => {
  const writes = [];
  const tx = {
    insert(table) {
      return {
        values(value) {
          writes.push({ table, value });
          return {
            onConflictDoNothing() {
              return { returning: async () => [account] };
            },
          };
        },
      };
    },
  };
  await new AuthService({ db: { transaction: (fn) => fn(tx) } }).signup(
    "client",
    account.email,
    account.displayName,
    password,
  );
  assert.deepEqual(
    writes.map((w) => w.table),
    [users, passwordCredentials],
  );
  assert.equal(writes[0].value.emailVerifiedAt, undefined);
  assert.equal(writes[0].value.accountType, "client");
  assert.match(writes[1].value.passwordHash, /^\$argon2id\$/);
  assert.ok(await argon2.verify(writes[1].value.passwordHash, password));
});
test("duplicate signup returns EMAIL_IN_USE without creating credentials", async () => {
  const tx = {
    insert(table) {
      assert.equal(table, users);
      return {
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      };
    },
  };
  await assert.rejects(
    new AuthService({ db: { transaction: (fn) => fn(tx) } }).signup(
      "client",
      account.email,
      account.displayName,
      password,
    ),
    (error) =>
      error.getStatus() === 409 && error.getResponse().code === "EMAIL_IN_USE",
  );
});
test("unverified account can log in; inactive and wrong-app accounts remain blocked", async () => {
  const credential = {
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
  };
  for (const [overrides, app, expected] of [
    [{}, "client", null],
    [{ status: "suspended" }, "client", "ACCOUNT_UNAVAILABLE"],
    [{}, "developer", "APP_MISMATCH"],
  ]) {
    const u = { ...account, ...overrides };
    const sessions = [];
    const tx = {
      select() {
        return {
          from(table) {
            return {
              where() {
                return table === users
                  ? { for: async () => [u] }
                  : Promise.resolve([credential]);
              },
            };
          },
        };
      },
      insert(table) {
        assert.equal(table, authSessions);
        return { values: async (value) => sessions.push(value) };
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: async () => [{ u, c: credential }] }),
        }),
      }),
      transaction: (fn) => fn(tx),
    };
    const login = new AuthService({ db }).login(app, u.email, password, false);
    if (expected) {
      await assert.rejects(
        login,
        (error) => error.getResponse().code === expected,
      );
      assert.equal(sessions.length, 0);
    } else {
      const result = await login;
      assert.equal(result.user.id, u.id);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].tokenHash, digest(result.raw));
      assert.equal(u.emailVerifiedAt, null);
    }
  }
});
test("me permits unverified users while querying active unexpired non-revoked app sessions", async () => {
  let query;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async (filter) => {
            query = new PgDialect().sqlToQuery(filter);
            return [{ u: account, s: { id: "session-1" } }];
          },
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  assert.equal(
    (await new AuthService({ db }).me("client", "token-value")).user.id,
    account.id,
  );
  assert.doesNotMatch(query.sql, /email_verified_at/);
  for (const field of [
    "token_hash",
    "app_kind",
    "revoked_at",
    "expires_at",
    "status",
    "account_type",
  ])
    assert.ok(query.sql.includes(field));
  assert.ok(query.params.includes("active"));
  assert.ok(query.params.includes(digest("token-value")));
});
