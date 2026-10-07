import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateUpload,
  transitions,
} from "../dist/workspace/requests.service.js";
const file = (mimetype, buffer) => ({
  mimetype,
  buffer,
  size: buffer.length,
  originalname: "sample.pdf",
});
test("request workflow requires review before completion and supports rework", () => {
  assert.deepEqual(transitions.received, ["in_progress"]);
  assert.equal(transitions.in_progress.includes("completed"), false);
  assert.ok(transitions.review.includes("revision"));
  assert.ok(transitions.completed.includes("revision"));
  assert.ok(transitions.completed.includes("released"));
});
test("attachment rejects declared MIME without matching file signature", () => {
  assert.throws(() =>
    validateUpload(file("image/png", Buffer.from("<script>"))),
  );
  assert.throws(() =>
    validateUpload(file("image/svg+xml", Buffer.from("<svg/>"))),
  );
  assert.throws(() => validateUpload(file("application/pdf", Buffer.from(""))));
});
test("attachment accepts supported signatures and sanitizes control and path characters", () => {
  assert.equal(
    validateUpload({
      ...file("application/pdf", Buffer.from("%PDF-1.7\n")),
      originalname: "../a\n.pdf",
    }),
    ".._a_.pdf",
  );
  assert.equal(
    validateUpload(
      file("image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ),
    "sample.pdf",
  );
  assert.equal(
    validateUpload(file("image/jpeg", Buffer.from([255, 216, 255, 224]))),
    "sample.pdf",
  );
});
