import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpException } from "@nestjs/common";
export type AppKind = "client" | "developer";
export const fail = (status: number, code: string, message: string): never => {
  throw new HttpException({ code, message }, status);
};
export const token = () => randomBytes(32).toString("hex");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function email(value: unknown) {
  if (
    typeof value !== "string" ||
    value.trim().length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    fail(400, "VALIDATION_ERROR", "올바른 이메일을 입력해주세요.");
  return (value as string).trim().toLowerCase();
}
export function password(value: unknown) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    fail(400, "VALIDATION_ERROR", "비밀번호는 12~128자로 입력해주세요.");
  return value as string;
}
export const accountType = (app: AppKind) =>
  app === "client" ? "client" : "team";
export function cookies(raw: string | undefined) {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? "").split(";")) {
    const i = entry.indexOf("=");
    if (i > 0) out[entry.slice(0, i).trim()] = entry.slice(i + 1).trim();
  }
  return out;
}
