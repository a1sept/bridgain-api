import assert from "node:assert/strict";
import { test } from "node:test";
import { allowsOrigin } from "../dist/auth/origins.js";

test("explicit extra origins allow local access while preserving app and host boundaries", () => {
  const previous = process.env.CLIENT_ADDITIONAL_ORIGINS;
  try {
    process.env.CLIENT_ADDITIONAL_ORIGINS = "http://localhost:15173, invalid, null";
    const primary = "http://nexusnas.iptime.org:15173";
    assert.equal(allowsOrigin("client", primary, primary), true);
    assert.equal(allowsOrigin("client", "http://localhost:15173", primary), true);
    for (const origin of [undefined, "null", "http://localhost:15174", "https://localhost:15173", "http://localhost:15173.evil.test"]) {
      assert.equal(allowsOrigin("client", origin, primary), false);
    }
    assert.equal(allowsOrigin("developer", "http://localhost:15173", "http://localhost:15174"), false);
  } finally {
    if (previous === undefined) delete process.env.CLIENT_ADDITIONAL_ORIGINS;
    else process.env.CLIENT_ADDITIONAL_ORIGINS = previous;
  }
});
