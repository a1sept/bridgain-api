import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthController } from "../dist/auth/auth.controller.js";
import {
  email,
  password,
  token,
  digest,
  cookies,
} from "../dist/auth/security.js";

test("identity normalization preserves plus tags; validation bounds passwords", () => {
  assert.equal(email("  User+tag@Example.COM "), "user+tag@example.com");
  assert.throws(
    () => email("bad@host"),
    (e) => e.getStatus() === 400,
  );
  assert.throws(
    () => password("short"),
    (e) => e.getStatus() === 400,
  );
  assert.throws(
    () => password("a".repeat(129)),
    (e) => e.getStatus() === 400,
  );
  assert.equal(password("a".repeat(12)), "a".repeat(12));
  const raw = token();
  assert.equal(raw.length, 64);
  assert.notEqual(raw, token());
  assert.notEqual(raw, digest(raw));
  assert.deepEqual(cookies("one=1; two=2"), { one: "1", two: "2" });
});

function harness() {
  process.env.AUTH_PROXY_SECRET = "test-only-proxy-secret-32-characters-long";
  const csrf = token();
  const headers = {
    "x-bridgain-app": "client",
    "x-bridgain-proxy-secret": process.env.AUTH_PROXY_SECRET,
    origin: "http://localhost:15173",
    cookie: `bridgain_client_csrf=${csrf}`,
    "x-csrf-token": csrf,
  };
  const req = {
    get: (key) => headers[key],
    socket: { remoteAddress: "127.0.0.1" },
    body: {},
  };
  const responseHeaders = {};
  const cookieWrites = [];
  const res = {
    setHeader: (k, v) => (responseHeaders[k] = v),
    cookie: (...args) => cookieWrites.push(args),
    clearCookie: (...args) => cookieWrites.push(args),
  };
  return { headers, req, res, responseHeaders, cookieWrites };
}
test("mutations require trusted proxy, matching Origin and app-specific CSRF before any auth operation", async () => {
  let calls = 0;
  const controller = new AuthController({
    origin: () => "http://localhost:15173",
    logout: async () => calls++,
  });
  for (const alter of [
    (h) => delete h["x-bridgain-proxy-secret"],
    (h) => (h.origin = "https://evil.test"),
    (h) => (h["x-csrf-token"] = token()),
    (h) => (h.cookie = h.cookie.replace("client", "developer")),
  ]) {
    const { headers, req, res } = harness();
    alter(headers);
    await assert.rejects(
      controller.logout(req, res),
      (e) => e.getStatus() === 403,
    );
  }
  assert.equal(calls, 0);
  const { req, res } = harness();
  await controller.logout(req, res);
  assert.equal(calls, 1);
});
test("signup ignores injected account type and role, passing only trusted app to service", async () => {
  let args;
  const controller = new AuthController({
    origin: () => "http://localhost:15173",
    signup: async (...value) => (args = value),
  });
  const { req, res } = harness();
  const body = {
    email: " User@Example.com ",
    displayName: " Client ",
    password: "my long password",
    accountType: "team",
    role: "owner",
  };
  const result = await controller.signup(req, res, body);
  assert.deepEqual(args, [
    "client",
    "user@example.com",
    "Client",
    "my long password",
  ]);
  assert.ok(result.message);
});
test("login cookie is HTTP-only, app-specific and persistent only for rememberMe", async () => {
  for (const rememberMe of [false, true]) {
    const { req, res, cookieWrites } = harness();
    const controller = new AuthController({
      origin: () => "http://localhost:15173",
      login: async () => ({
        raw: token(),
        expiresAt: new Date(Date.now() + 10000),
        user: { id: "id" },
      }),
    });
    assert.deepEqual(
      await controller.login(req, res, {
        email: "user@example.com",
        password: "my long password",
        rememberMe,
      }),
      { user: { id: "id" } },
    );
    assert.equal(cookieWrites[0][0], "bridgain_client_session");
    assert.equal(cookieWrites[0][2].httpOnly, true);
    assert.equal(cookieWrites[0][2].sameSite, "lax");
    assert.equal("expires" in cookieWrites[0][2], rememberMe);
  }
});
test("account rate limit aggregates different proxy IPs and returns Retry-After", async () => {
  const controller = new AuthController({
    origin: () => "http://localhost:15173",
    signup: async () => {},
  });
  for (let i = 0; i < 6; i++) {
    const { req, res, headers, responseHeaders } = harness();
    headers["x-bridgain-client-ip"] = `127.0.0.${i}`;
    req.body = {
      email: "same@example.com",
      displayName: "Tester",
      password: "my long password",
    };
    if (i < 5) await controller.signup(req, res, req.body);
    else {
      await assert.rejects(
        controller.signup(req, res, req.body),
        (e) => e.getStatus() === 429,
      );
      assert.ok(Number(responseHeaders["Retry-After"]) > 0);
    }
  }
});

test("CSRF requests reuse the existing app token across tabs", () => {
  const controller = new AuthController({});
  const { req, res, headers, cookieWrites } = harness();
  const first = controller.csrf(req, res);
  assert.equal(first.csrfToken, headers["x-csrf-token"]);
  assert.equal(controller.csrf(req, res).csrfToken, first.csrfToken);
  assert.equal(cookieWrites[0][2].httpOnly, true);
  headers.cookie = "bridgain_client_csrf=invalid";
  assert.match(controller.csrf(req, res).csrfToken, /^[a-f0-9]{64}$/);
});
