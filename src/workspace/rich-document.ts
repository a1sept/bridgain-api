import { fail } from "../auth/security.js";
export type RichDocument = { version: 1; blocks: Record<string, unknown>[] };
const blockTypes = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
]);
const colors = new Set([
  "default",
  "gray",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);
export function parseRichDocument(raw: unknown): RichDocument | null {
  if (raw === undefined || raw === null) return null;
  const bad = (): never =>
    fail(400, "INVALID_DOCUMENT", "업무 문서 형식 또는 크기를 확인해주세요.");
  if (typeof raw !== "object" || Array.isArray(raw)) return bad();
  const doc = raw as Record<string, unknown>;
  if (
    doc.version !== 1 ||
    !Array.isArray(doc.blocks) ||
    !doc.blocks.length ||
    JSON.stringify(raw).length > 250000
  )
    return bad();
  let count = 0,
    textLength = 0;
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return bad();
    return v as Record<string, unknown>;
  };
  const inline = (v: unknown, allowLink = true): Record<string, unknown>[] => {
    if (!Array.isArray(v) || v.length > 10000) return bad();
    return v.map((item) => {
      const x = record(item);
      if (x.type === "text") {
        if (typeof x.text !== "string") return bad();
        textLength += x.text.length;
        if (textLength > 10000) return bad();
        const styles = record(x.styles ?? {});
        for (const [key, value] of Object.entries(styles)) {
          if (["bold", "italic", "underline", "strike", "code"].includes(key)) {
            if (typeof value !== "boolean") return bad();
          } else if (["textColor", "backgroundColor"].includes(key)) {
            if (typeof value !== "string" || !colors.has(value)) return bad();
          } else return bad();
        }
        return { type: "text", text: x.text, styles };
      }
      if (x.type === "link" && allowLink) {
        if (
          typeof x.href !== "string" ||
          x.href.length > 2000 ||
          !/^https?:\/\/|^mailto:/i.test(x.href) ||
          /[\u0000-\u0020]/.test(x.href)
        )
          return bad();
        return {
          type: "link",
          href: x.href,
          content: inline(x.content, false),
        };
      }
      return bad();
    });
  };
  const ids = new Set<string>();
  const blocks = (v: unknown, depth = 0): Record<string, unknown>[] => {
    if (!Array.isArray(v) || depth > 8) return bad();
    return v.map((item) => {
      if (++count > 200) return bad();
      const x = record(item);
      if (
        typeof x.type !== "string" ||
        !blockTypes.has(x.type) ||
        typeof x.id !== "string" ||
        !x.id.length ||
        x.id.length > 100 ||
        ids.has(x.id)
      )
        return bad();
      ids.add(x.id);
      const props = record(x.props ?? {});
      for (const [key, value] of Object.entries(props)) {
        if (["textColor", "backgroundColor"].includes(key)) {
          if (typeof value !== "string" || !colors.has(value)) return bad();
        } else if (key === "textAlignment") {
          if (!["left", "center", "right", "justify"].includes(String(value)))
            return bad();
        } else if (key === "level" && x.type === "heading") {
          if (
            ![1, 2, 3, 4, 5, 6].includes(Number(value)) ||
            typeof value !== "number"
          )
            return bad();
        } else if (key === "checked" && x.type === "checkListItem") {
          if (typeof value !== "boolean") return bad();
        } else if (key === "start" && x.type === "numberedListItem") {
          if (
            !Number.isInteger(value) ||
            Number(value) < 0 ||
            Number(value) > 100000
          )
            return bad();
        } else if (key === "isToggleable" && x.type === "heading") {
          if (value !== false) return bad();
        } else return bad();
      }
      return {
        id: x.id,
        type: x.type,
        props,
        content: inline(x.content ?? []),
        children: blocks(x.children ?? [], depth + 1),
      };
    });
  };
  const result: RichDocument = { version: 1, blocks: blocks(doc.blocks) };
  if (richDocumentText(result).length > 10000) return bad();
  return result;
}
export function richDocumentText(doc: RichDocument): string {
  const inline = (items: unknown): string =>
    (items as Record<string, unknown>[])
      .map((x) => (x.type === "text" ? String(x.text) : inline(x.content)))
      .join("");
  const lines = (items: Record<string, unknown>[]): string[] =>
    items.flatMap((x) => [
      inline(x.content),
      ...lines(x.children as Record<string, unknown>[]),
    ]);
  return lines(doc.blocks).join("\n");
}
