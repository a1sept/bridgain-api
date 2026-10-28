import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRichDocument,
  richDocumentText,
} from "../dist/workspace/rich-document.js";
import { parseStagePlans } from "../dist/workspace/stage-plan-policy.js";
const block = (id, text, type = "paragraph", props = {}) => ({
  id,
  type,
  props,
  content: [{ type: "text", text, styles: { bold: true } }],
  children: [],
});
const doc = {
  version: 1,
  blocks: [
    block("a", "기존 내용", "heading", { level: 2, isToggleable: false }),
    block("b", "진행 확인", "checkListItem", { checked: true }),
  ],
};
test("document preserves formatting and extracts legacy text", () => {
  assert.deepEqual(parseRichDocument(doc), doc);
  assert.equal(richDocumentText(doc), "기존 내용\n진행 확인");
  assert.equal(parseRichDocument(null), null);
});
test("document rejects unsupported blocks, duplicate IDs, unsafe links and oversized text", () => {
  for (const invalid of [
    { version: 2, blocks: doc.blocks },
    { version: 1, blocks: [block("a", "x", "image")] },
    { version: 1, blocks: [block("a", "x"), block("a", "y")] },
    { version: 1, blocks: [block("a", "x".repeat(10001))] },
    {
      version: 1,
      blocks: [
        {
          ...block("a", ""),
          content: [{ type: "link", href: "javascript:alert(1)", content: [] }],
        },
      ],
    },
  ])
    assert.throws(() => parseRichDocument(invalid));
});
test("stage approval retains document and derives plain text from it", () => {
  const person = "00000000-0000-4000-8000-000000000001";
  const stage = {
    id: "a",
    name: "기획",
    title: "업무",
    brief: "forged text",
    briefDocument: doc,
    completionMode: "document",
    assigneeIds: [person],
    reviewerIds: [person],
    dependsOn: [],
  };
  const [parsed] = parseStagePlans([stage]);
  assert.deepEqual(parsed.briefDocument, doc);
  assert.equal(parsed.brief, "기존 내용\n진행 확인");
  assert.throws(() =>
    parseStagePlans([
      { ...stage, briefDocument: { version: 1, blocks: [block("a", "")] } },
    ]),
  );
});
