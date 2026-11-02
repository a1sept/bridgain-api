import { fail } from "../auth/security.js";
export type AttendancePolicy = {
  mode: "duration" | "deadline";
  minimumMinutes: number;
  reference: "scheduled" | "actual";
  graceMinutes: number;
  lateEntry: "allow" | "block";
  endPresenceMinutes: number | null;
  includeWaiting: boolean;
};
export const defaultAttendancePolicy: AttendancePolicy = {
  mode: "duration",
  minimumMinutes: 0,
  reference: "scheduled",
  graceMinutes: 10,
  lateEntry: "allow",
  endPresenceMinutes: null,
  includeWaiting: false,
};
export function attendancePolicy(input: unknown): AttendancePolicy {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "VALIDATION_ERROR", "출석 설정을 확인해주세요.");
  const p = input as Record<string, unknown>;
  for (const key of ["minimumMinutes", "graceMinutes"]) {
    if (
      !Number.isInteger(p[key]) ||
      Number(p[key]) < (key === "minimumMinutes" ? 1 : 0) ||
      Number(p[key]) > 1440
    )
      fail(
        400,
        "VALIDATION_ERROR",
        "출석 기준 시간은 0~1440분 안에서 설정해주세요. 최소 참여 시간은 1분 이상입니다.",
      );
  }
  if (
    !["duration", "deadline"].includes(String(p.mode)) ||
    !["scheduled", "actual"].includes(String(p.reference)) ||
    !["allow", "block"].includes(String(p.lateEntry)) ||
    typeof p.includeWaiting !== "boolean" ||
    (p.endPresenceMinutes !== null &&
      (!Number.isInteger(p.endPresenceMinutes) ||
        Number(p.endPresenceMinutes) < 0 ||
        Number(p.endPresenceMinutes) > 1440))
  )
    fail(400, "VALIDATION_ERROR", "출석 설정을 확인해주세요.");
  return {
    mode: p.mode as AttendancePolicy["mode"],
    minimumMinutes: Number(p.minimumMinutes),
    reference: p.reference as AttendancePolicy["reference"],
    graceMinutes: Number(p.graceMinutes),
    lateEntry: p.lateEntry as AttendancePolicy["lateEntry"],
    endPresenceMinutes:
      p.endPresenceMinutes === null ? null : Number(p.endPresenceMinutes),
    includeWaiting: p.includeWaiting as boolean,
  };
}
type Interval = [number, number];
export function unionIntervals(input: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [start, end] of input
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
export function attendanceResult(
  policy: AttendancePolicy,
  joins: Interval[],
  waits: Interval[],
  scheduledStart: number,
  scheduledEnd: number,
  actualStart: number,
) {
  const merged = unionIntervals(joins),
    waiting = unionIntervals(waits);
  let ms = merged.reduce((n, [a, b]) => n + b - a, 0);
  if (!policy.includeWaiting)
    for (const [a, b] of merged)
      for (const [c, d] of waiting)
        ms -= Math.max(0, Math.min(b, d) - Math.max(a, c));
  const first = merged[0]?.[0];
  const late =
    policy.mode === "deadline" &&
    first !== undefined &&
    first >
      (policy.reference === "actual" ? actualStart : scheduledStart) +
        policy.graceMinutes * 60000;
  const endOk =
    policy.endPresenceMinutes === null ||
    merged.some(
      ([a, b]) =>
        a <= scheduledEnd - policy.endPresenceMinutes! * 60000 &&
        b >= scheduledEnd - policy.endPresenceMinutes! * 60000,
    );
  return {
    seconds: Math.floor(Math.max(0, ms) / 1000),
    late,
    eligible:
      first !== undefined &&
      !late &&
      endOk &&
      ms >= policy.minimumMinutes * 60000,
    firstJoinedAt: first ? new Date(first).toISOString() : null,
  };
}
