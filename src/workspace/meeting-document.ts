import { parseRichDocument, richDocumentText, type RichDocument } from "./rich-document.js";

// Legacy clients may submit plain text without a document. Keep formatting only
// while that text still matches the saved document; otherwise clear stale blocks.
export function meetingDocument(raw: unknown, text: unknown, previousText: string, previous: RichDocument | null, maxLength = 10000) {
  const document = raw === undefined
    ? (text === undefined || text === previousText ? previous : null)
    : parseRichDocument(raw, maxLength);
  return { document, text: document ? richDocumentText(document) : text ?? previousText };
}
