import { fail } from "../auth/security.js";

export function dueDate(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail(400, "VALIDATION_ERROR", "올바른 날짜를 입력해주세요.");
  return value as string;
}
