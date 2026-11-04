import * as Y from "yjs";
import { fail } from "../auth/security.js";
import { uuid } from "./workspace.service.js";
function formatting(m: Y.Map<unknown>) {
  const rotation = Number(m.get("rotation") ?? 0), fontFamily = String(m.get("fontFamily") ?? ""), align = String(m.get("align") ?? "left");
  if (!Number.isFinite(rotation) || rotation < -180 || rotation > 180 ||
    !["", "sans-serif", "serif", "monospace", "Arial", "Georgia"].includes(fontFamily) || !["left", "center", "right"].includes(align))
    fail(400, "DECK_INVALID", "텍스트 서식을 확인해주세요.");
  return { rotation, fontFamily, align: align as "left" | "center" | "right", bold: m.get("bold") === true, italic: m.get("italic") === true };
}
function legacyStyle(doc: Y.Doc, key: string, title: boolean) {
  const m = doc.getMap(`element:${key}`);
  const style = { x: 6, y: title ? 5 : 20, w: 88, h: title ? 13 : 15, fontSize: title ? 38.4 : 22.08, color: "#202431", ...m.toJSON(), ...formatting(m), bold: m.has("bold") ? m.get("bold") === true : title };
  const { x, y, w, h, fontSize, color } = style;
  if ([x,y,w,h,fontSize].some(v => typeof v !== "number" || !Number.isFinite(v)) || x < 0 || y < 0 || w < 2 || h < 2 || x + w > 100.1 || y + h > 100.1 || fontSize < 10 || fontSize > 96 || !/^#[0-9a-f]{6}$/i.test(color))
    fail(400, "DECK_INVALID", "텍스트 상자의 위치·크기를 확인해주세요.");
  return style;
}
export function studySlide(doc: Y.Doc, pageId: string) {
  const ids = doc.getArray<string>(`elements:${pageId}`).toArray();
  if (ids.length > 50)
    fail(
      400,
      "DECK_LIMIT",
      "한 페이지에는 최대 50개 요소를 추가할 수 있습니다.",
    );
  const elements = ids.map((id) => {
    uuid(id);
    const m = doc.getMap(`element:${id}`);
    const type = String(m.get("type"));
    if (!["text", "asset", "youtube"].includes(type))
      fail(400, "DECK_INVALID", "요소 종류를 확인해주세요.");
    const x = Number(m.get("x")),
      y = Number(m.get("y")),
      w = Number(m.get("w")),
      h = Number(m.get("h")),
      fontSize = Number(m.get("fontSize") ?? 24),
      color = String(m.get("color") ?? "#202431");
    if (
      [x, y, w, h, fontSize].some((v) => !Number.isFinite(v)) ||
      x < 0 ||
      y < 0 ||
      w < 2 ||
      h < 2 ||
      x + w > 100.1 ||
      y + h > 100.1 ||
      fontSize < 10 ||
      fontSize > 96 ||
      !/^#[0-9a-f]{6}$/i.test(color)
    )
      fail(400, "DECK_INVALID", "요소의 위치·크기를 확인해주세요.");
    const text = doc.getText(`text:${id}`).toString();
    if (text.length > 10000) fail(400, "DECK_LIMIT", "텍스트가 너무 깁니다.");
    const assetId = type === "asset" ? uuid(m.get("assetId")) : undefined;
    const videoId = type === "youtube" ? String(m.get("videoId")) : undefined;
    if (videoId && !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
      fail(400, "DECK_INVALID", "YouTube 영상을 확인해주세요.");
    return {
      ...formatting(m),
      id,
      type,
      x,
      y,
      w,
      h,
      fontSize,
      color,
      text,
      assetId,
      videoId,
      mime: type === "asset" ? String(m.get("mime") ?? "") : undefined,
    };
  });
  const background = String(
    doc.getMap(`style:${pageId}`).get("background") ?? "#ffffff",
  );
  if (!/^#[0-9a-f]{6}$/i.test(background))
    fail(400, "DECK_INVALID", "배경색을 확인해주세요.");
  return {
    titleStyle: legacyStyle(doc, `title:${pageId}`, true),
    bodyStyle: legacyStyle(doc, `body:${pageId}`, false),
    title: doc.getText(`title:${pageId}`).toString(),
    body: doc.getText(`body:${pageId}`).toString(),
    background,
    elements,
  };
}
