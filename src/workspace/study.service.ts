import { randomUUID, createHash } from "node:crypto";
import { parseRichDocument, richDocumentText } from "./rich-document.js";
import { Injectable } from "@nestjs/common";
import { and, eq, asc, inArray, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { projects, projectMemberships as pm } from "../db/schema/workspace.js";
import { users } from "../db/schema/auth.js";
import {
  projectRoles,
  projectMemberRoles,
} from "../db/schema/project-roles.js";
import {
  studyPrograms as programs,
  studyProgramMembers as members,
  studyOrganizers as organizers,
  studySessions as sessions,
  studyActivities as activities,
  studySubmissionVersions as submissions,
  studyAssets as assets,
  studyDecks as decks,
  studyRoleDefaults as roleDefaults,
  studyLiveConnections as liveConnections,
  studySubmissionAssets as submissionAssets,
} from "../db/schema/study.js";
import { fail } from "../auth/security.js";
import { bounded, uuid } from "./workspace.service.js";
import { resolveProjectPermissions } from "./project-roles.service.js";
import { studyPermissions, studyRoleTemplates } from "./study-policy.js";
type User = { id: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
@Injectable()
export class StudyService {
  constructor(private readonly database: DatabaseService) {}
  private async access(tx: Tx, u: User, pid: string, permission?: string) {
    const [p] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, uuid(pid)))
      .for("update");
    if (!p || p.kind !== "study")
      fail(404, "NOT_FOUND", "스터디를 찾을 수 없습니다.");
    const a = await resolveProjectPermissions(tx, u, pid);
    if (permission && !a.permissions.includes(permission))
      fail(403, "FORBIDDEN", "이 작업의 권한이 없습니다.");
    return a;
  }
  async snapshot(
    u: User,
    pid: string,
    page?: {
      programId?: string;
      sessionCursor?: string;
      activityCursor?: string;
    },
  ) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.access(tx, u, pid);
      const all = await tx
        .select()
        .from(programs)
        .where(eq(programs.projectId, pid))
        .orderBy(asc(programs.createdAt));
      const ids = all.map((p) => p.id);
      const targets = ids.length
        ? await tx.select().from(members).where(inArray(members.programId, ids))
        : [];
      const hosts = ids.length
        ? await tx
            .select()
            .from(organizers)
            .where(inArray(organizers.programId, ids))
        : [];
      const visible = all.filter(
        (p) =>
          access.permissions.some((p) =>
            [
              "study.programs.manage",
              "study.sessions.manage",
              "study.activities.manage",
              "study.materials.manage",
              "study.submissions.read",
              "study.attendance.read",
              "study.attendance.adjust",
              "study.live.host",
            ].includes(p),
          ) ||
          hosts.some((h) => h.programId === p.id && h.userId === u.id) ||
          targets.some(
            (m) => m.programId === p.id && m.userId === u.id && !m.leftAt,
          ) ||
          (p.status === "preparing" && p.membershipMode === "all"),
      );
      const visibleIds = visible.map((p) => p.id);
      if (page?.programId && !visibleIds.includes(uuid(page.programId)))
        fail(404, "NOT_FOUND", "프로그램을 찾을 수 없습니다.");
      const listIds = page?.programId ? [page.programId] : visibleIds;
      const sessionCursor = page?.sessionCursor
        ? uuid(page.sessionCursor)
        : undefined;
      const activityCursor = page?.activityCursor
        ? uuid(page.activityCursor)
        : undefined;
      if (sessionCursor) {
        const [anchor] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionCursor),
              inArray(sessions.programId, listIds),
            ),
          );
        if (!anchor)
          fail(400, "INVALID_CURSOR", "회차 목록을 새로 열어주세요.");
      }
      if (activityCursor) {
        const [anchor] = await tx
          .select()
          .from(activities)
          .where(
            and(
              eq(activities.id, activityCursor),
              inArray(activities.programId, listIds),
            ),
          );
        if (!anchor)
          fail(400, "INVALID_CURSOR", "활동 목록을 새로 열어주세요.");
      }
      const sessionRows = listIds.length
        ? await tx
            .select()
            .from(sessions)
            .where(
              and(
                inArray(sessions.programId, listIds),
                sessionCursor
                  ? sql`(${sessions.startsAt}, ${sessions.id}) > ((SELECT starts_at FROM study_sessions WHERE id=${sessionCursor}::uuid), ${sessionCursor}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(asc(sessions.startsAt), asc(sessions.id))
            .limit(page ? 51 : 2147483647)
        : [];
      const activityRows = listIds.length
        ? await tx
            .select()
            .from(activities)
            .where(
              and(
                inArray(activities.programId, listIds),
                activityCursor
                  ? sql`(${activities.dueAt}, ${activities.id}) > ((SELECT due_at FROM study_activities WHERE id=${activityCursor}::uuid), ${activityCursor}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(asc(activities.dueAt), asc(activities.id))
            .limit(page ? 51 : 2147483647)
        : [];

      const rows = await tx
        .select({ userId: pm.userId, displayName: users.displayName })
        .from(pm)
        .innerJoin(users, eq(users.id, pm.userId))
        .where(eq(pm.projectId, pid));
      const roles = await tx
        .select()
        .from(projectRoles)
        .where(eq(projectRoles.projectId, pid));
      const defaults = roles.length
        ? await tx
            .select()
            .from(roleDefaults)
            .where(
              inArray(
                roleDefaults.roleId,
                roles.map((r) => r.id),
              ),
            )
        : [];
      const assignments = await tx
        .select()
        .from(projectMemberRoles)
        .where(eq(projectMemberRoles.projectId, pid));
      return {
        permissions: access.permissions,
        isOwner: access.isOwner,
        programs: visible.map((p) => ({
          ...p,
          memberIds: targets
            .filter((m) => m.programId === p.id && !m.leftAt)
            .map((m) => m.userId),
          organizers: hosts.filter((h) => h.programId === p.id),
        })),
        sessions: page ? sessionRows.slice(0, 50) : sessionRows,
        activities: page ? activityRows.slice(0, 50) : activityRows,
        pagination: {
          sessions: page && sessionRows.length > 50 ? sessionRows[49].id : null,
          activities:
            page && activityRows.length > 50 ? activityRows[49].id : null,
        },
        // Lightweight choices remain complete, so older sessions can still be
        // attached to an activity even before scrolling the schedule list.
        sessionOptions:
          page && listIds.length
            ? await tx
                .select({
                  id: sessions.id,
                  title: sessions.title,
                  programId: sessions.programId,
                })
                .from(sessions)
                .where(inArray(sessions.programId, listIds))
                .orderBy(asc(sessions.startsAt), asc(sessions.id))
            : undefined,
        members: rows.map((m) => ({
          ...m,
          roleIds: assignments
            .filter((a) => a.userId === m.userId)
            .map((a) => a.roleId),
        })),
        roles: roles.map((r) => ({
          ...r,
          defaultPermissions: defaults.find((d) => d.roleId === r.id)
            ? JSON.parse(defaults.find((d) => d.roleId === r.id)!.permissions)
            : null,
        })),
      };
    });
  }
  private plannedCount(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 500)
      fail(400, "VALIDATION_ERROR", "계획 회차 수는 1~500 사이여야 합니다.");
    return Number(value);
  }
  async createProgram(u: User, pid: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, "study.programs.manage");
      const requestId = b.requestId ? uuid(b.requestId) : undefined;
      if (requestId) {
        const [existing] = await tx
          .select()
          .from(programs)
          .where(eq(programs.id, requestId));
        if (existing) {
          if (existing.projectId !== pid || existing.createdBy !== u.id)
            fail(
              409,
              "REQUEST_CONFLICT",
              "프로그램 생성 요청을 다시 시작해주세요.",
            );
          return existing;
        }
      }
      const mode = b.membershipMode ?? "all";
      if (!["all", "selected"].includes(mode as string))
        fail(400, "VALIDATION_ERROR", "참여 대상을 확인해주세요.");
      const memberIds = this.ids(b.memberIds ?? []);
      const hostIds = this.ids(b.hostIds ?? [u.id]);
      if (!hostIds.length || (mode === "selected" && !memberIds.length))
        fail(400, "VALIDATION_ERROR", "운영진과 참여자를 선택해주세요.");
      await this.checkMembers(tx, pid, [...memberIds, ...hostIds]);
      const [p] = await tx
        .insert(programs)
        .values({
          id: requestId,
          projectId: pid,
          title: bounded(b.title, 120),
          description: bounded(b.description ?? "", 2000, false),
          membershipMode: mode as string,
          plannedSessionCount: this.plannedCount(b.plannedSessionCount),
          createdBy: u.id,
        })
        .returning();
      if (memberIds.length)
        await tx
          .insert(members)
          .values(memberIds.map((userId) => ({ programId: p.id, userId })));
      await tx
        .insert(organizers)
        .values(
          hostIds.map((userId) => ({ programId: p.id, userId, role: "host" })),
        );
      return p;
    });
  }
  private ids(value: unknown) {
    if (!Array.isArray(value) || value.length > 500)
      fail(400, "VALIDATION_ERROR", "회원 목록을 확인해주세요.");
    return [...new Set((value as unknown[]).map(uuid))];
  }
  private async checkMembers(tx: Tx, pid: string, ids: string[]) {
    const rows = await tx.select().from(pm).where(eq(pm.projectId, pid));
    if (ids.some((id) => !rows.some((m) => m.userId === id)))
      fail(400, "VALIDATION_ERROR", "프로젝트 회원만 지정할 수 있습니다.");
  }
  private async program(tx: Tx, pid: string, id: string) {
    const [p] = await tx
      .select()
      .from(programs)
      .where(and(eq(programs.id, uuid(id)), eq(programs.projectId, pid)))
      .for("update");
    if (!p) fail(404, "NOT_FOUND", "프로그램을 찾을 수 없습니다.");
    return p;
  }
  async updateProgram(
    u: User,
    pid: string,
    id: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, "study.programs.manage");
      const p = await this.program(tx, pid, id);
      const action = b.action;
      if (action === "delete") {
        const children = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.programId, id));
        const assignments = await tx
          .select()
          .from(activities)
          .where(eq(activities.programId, id));
        const documents = await tx
          .select()
          .from(decks)
          .where(eq(decks.programId, id));
        if (
          p.status !== "preparing" ||
          children.length ||
          assignments.length ||
          documents.length
        )
          fail(
            409,
            "HAS_RECORDS",
            "기록이 있는 프로그램은 삭제 대신 보관해주세요.",
          );
        await tx.delete(organizers).where(eq(organizers.programId, id));
        await tx.delete(members).where(eq(members.programId, id));
        await tx.delete(programs).where(eq(programs.id, id));
        return { ok: true };
      }
      if (action === "restore")
        return (
          await tx
            .update(programs)
            .set({ archivedAt: null })
            .where(eq(programs.id, id))
            .returning()
        )[0];
      if (p.archivedAt)
        fail(409, "ARCHIVED", "보관된 프로그램입니다. 먼저 복원해주세요.");
      if (action === "start") {
        if (p.status !== "preparing")
          fail(409, "STATE_CONFLICT", "이미 시작한 프로그램입니다.");
        if (p.membershipMode === "all") {
          const rows = await tx.select().from(pm).where(eq(pm.projectId, pid));
          if (rows.length)
            await tx
              .insert(members)
              .values(rows.map((m) => ({ programId: id, userId: m.userId })))
              .onConflictDoNothing();
        }
        return (
          await tx
            .update(programs)
            .set({ status: "active", startedAt: new Date() })
            .where(eq(programs.id, id))
            .returning()
        )[0];
      }
      if (action === "archive") {
        const live = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.programId, id), eq(sessions.status, "live")));
        if (live.length)
          fail(409, "LIVE_ACTIVE", "라이브를 먼저 종료해주세요.");
        return (
          await tx
            .update(programs)
            .set({ archivedAt: new Date() })
            .where(eq(programs.id, id))
            .returning()
        )[0];
      }
      if (action === "complete") {
        const live = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.programId, id), eq(sessions.status, "live")));
        if (live.length)
          fail(409, "LIVE_ACTIVE", "라이브를 먼저 종료해주세요.");
        if (p.status !== "active")
          fail(409, "STATE_CONFLICT", "진행 중 프로그램만 완료할 수 있습니다.");
        return (
          await tx
            .update(programs)
            .set({ status: "completed" })
            .where(eq(programs.id, id))
            .returning()
        )[0];
      }
      if (action !== undefined)
        fail(400, "VALIDATION_ERROR", "처리 방식을 확인해주세요.");
      if (b.hostIds !== undefined) {
        const ids = this.ids(b.hostIds);
        if (!ids.length)
          fail(400, "VALIDATION_ERROR", "주최자를 한 명 이상 지정해주세요.");
        await this.checkMembers(tx, pid, ids);
        await tx
          .delete(organizers)
          .where(
            and(eq(organizers.programId, id), eq(organizers.role, "host")),
          );
        for (const userId of ids)
          await tx
            .insert(organizers)
            .values({ programId: id, userId, role: "host" })
            .onConflictDoUpdate({
              target: [organizers.programId, organizers.userId],
              set: { role: "host" },
            });
      }
      if (b.membershipMode !== undefined) {
        if (p.status !== "preparing")
          fail(
            409,
            "MEMBERS_LOCKED",
            "시작한 프로그램의 참여 명단은 변경할 수 없습니다.",
          );
        if (!["all", "selected"].includes(String(b.membershipMode)))
          fail(400, "VALIDATION_ERROR", "참여 대상을 확인해주세요.");
        const ids = this.ids(b.memberIds ?? []);
        await this.checkMembers(tx, pid, ids);
        if (b.membershipMode === "selected" && !ids.length)
          fail(400, "VALIDATION_ERROR", "참여 회원을 선택해주세요.");
        await tx.delete(members).where(eq(members.programId, id));
        if (b.membershipMode === "selected")
          await tx
            .insert(members)
            .values(ids.map((userId) => ({ programId: id, userId })));
        await tx
          .update(programs)
          .set({ membershipMode: String(b.membershipMode) })
          .where(eq(programs.id, id));
      }
      return (
        await tx
          .update(programs)
          .set({
            title: bounded(b.title, 120),
            description: bounded(b.description ?? "", 2000, false),
            plannedSessionCount:
              b.plannedSessionCount === undefined
                ? p.plannedSessionCount
                : this.plannedCount(b.plannedSessionCount),
          })
          .where(eq(programs.id, id))
          .returning()
      )[0];
    });
  }
  async setOrganizers(
    u: User,
    pid: string,
    id: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid),
        p = await this.program(tx, pid, id);
      const existing = await tx
        .select()
        .from(organizers)
        .where(eq(organizers.programId, id));
      if (
        !a.permissions.includes("study.programs.manage") &&
        !existing.some((o) => o.userId === u.id && o.role === "host")
      )
        fail(
          403,
          "FORBIDDEN",
          "주최자만 프로그램 부관리자를 지정할 수 있습니다.",
        );
      if (p.archivedAt) fail(409, "ARCHIVED", "보관된 프로그램입니다.");
      const deputies = this.ids(b.deputyIds ?? []),
        hostIds = existing
          .filter((o) => o.role === "host")
          .map((o) => o.userId);
      await this.checkMembers(tx, pid, deputies);
      await tx
        .delete(organizers)
        .where(
          and(eq(organizers.programId, id), eq(organizers.role, "deputy")),
        );
      const ids = deputies.filter((userId) => !hostIds.includes(userId));
      if (ids.length)
        await tx
          .insert(organizers)
          .values(
            ids.map((userId) => ({ programId: id, userId, role: "deputy" })),
          );
      return { ok: true };
    });
  }
  async saveSession(
    u: User,
    pid: string,
    id: string,
    b: Record<string, unknown>,
    sid?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      const p = await this.program(tx, pid, id);
      const [host] = await tx
        .select()
        .from(organizers)
        .where(and(eq(organizers.programId, id), eq(organizers.userId, u.id)));
      if (!host && !a.permissions.includes("study.sessions.manage"))
        fail(403, "FORBIDDEN", "회차 관리 권한이 필요합니다.");
      if (p.archivedAt || p.status === "completed")
        fail(
          409,
          "STATE_CONFLICT",
          "완료·보관된 프로그램은 회차를 변경할 수 없습니다.",
        );
      if (sid && b.action === "cancel") {
        const [s] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, uuid(sid)), eq(sessions.programId, id)))
          .for("update");
        if (!s || s.status !== "scheduled")
          fail(409, "STATE_CONFLICT", "예정 회차만 취소할 수 있습니다.");
        return (
          await tx
            .update(sessions)
            .set({ status: "canceled" })
            .where(eq(sessions.id, sid))
            .returning()
        )[0];
      }
      const requestId = !sid && b.requestId ? uuid(b.requestId) : undefined;
      if (requestId) {
        const [existing] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, requestId));
        if (existing) {
          if (existing.programId !== id)
            fail(
              409,
              "REQUEST_CONFLICT",
              "회차 생성 요청을 다시 시작해주세요.",
            );
          return existing;
        }
      }
      const startsAt = new Date(String(b.startsAt)),
        endsAt = new Date(String(b.endsAt));
      if (
        !Number.isFinite(+startsAt) ||
        !Number.isFinite(+endsAt) ||
        endsAt <= startsAt
      )
        fail(400, "VALIDATION_ERROR", "시작·종료 시간을 확인해주세요.");
      const values = {
        title: bounded(b.title, 120),
        startsAt,
        endsAt,
        location: bounded(b.location ?? "", 500, false),
      };
      if (sid) {
        const [s] = await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, uuid(sid)), eq(sessions.programId, id)))
          .for("update");
        if (!s) fail(404, "NOT_FOUND", "회차를 찾을 수 없습니다.");
        if (s.status !== "scheduled")
          fail(409, "STATE_CONFLICT", "예정 회차만 수정할 수 있습니다.");
        const scope = b.scope ?? "single";
        if (!["single", "following", "series"].includes(String(scope)))
          fail(400, "VALIDATION_ERROR", "변경 범위를 확인해주세요.");
        if (scope !== "single") {
          if (!s.seriesId)
            fail(409, "NO_SERIES", "반복 묶음이 없는 회차입니다.");
          const siblings = await tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.programId, id),
                eq(sessions.seriesId, s.seriesId!),
              ),
            )
            .for("update");
          // Individually moved sessions and historical records are never overwritten.
          const targets = siblings.filter(
            (row) =>
              row.status === "scheduled" &&
              (row.id === sid || !row.scheduleException) &&
              (scope === "series" || row.seriesIndex! >= s.seriesIndex!),
          );
          const revision = createHash("sha256")
            .update(
              JSON.stringify(siblings.sort((x, y) => x.id.localeCompare(y.id))),
            )
            .digest("hex");
          if (b.preview === true)
            return {
              revision,
              affected: targets.map((row) => ({
                id: row.id,
                title: row.title,
                startsAt: new Date(+row.startsAt + (+startsAt - +s.startsAt)),
                endsAt: new Date(
                  +row.startsAt +
                    (+startsAt - +s.startsAt) +
                    (+endsAt - +startsAt),
                ),
              })),
              protectedCount: siblings.length - targets.length,
            };
          // Guard against a stale preview or retried relative time shift.
          if (
            b.expectedRevision !== revision ||
            b.expectedStartsAt !== s.startsAt.toISOString() ||
            JSON.stringify([...targets.map((row) => row.id)].sort()) !==
              JSON.stringify(
                Array.isArray(b.expectedIds) ? [...b.expectedIds].sort() : [],
              )
          )
            fail(
              409,
              "SCHEDULE_CHANGED",
              "일정이 변경됐습니다. 변경 내용을 다시 확인해주세요.",
            );
          for (const row of targets)
            await tx
              .update(sessions)
              .set({
                startsAt: new Date(+row.startsAt + (+startsAt - +s.startsAt)),
                endsAt: new Date(
                  +row.startsAt +
                    (+startsAt - +s.startsAt) +
                    (+endsAt - +startsAt),
                ),
                ...(values.location !== s.location
                  ? { location: values.location }
                  : {}),
                ...(row.id === sid ? { title: values.title } : {}),
              })
              .where(eq(sessions.id, row.id));
          return (
            await tx.select().from(sessions).where(eq(sessions.id, sid))
          )[0];
        }
        return (
          await tx
            .update(sessions)
            .set({ ...values, scheduleException: !!s.seriesId })
            .where(eq(sessions.id, sid))
            .returning()
        )[0];
      }
      const count = b.repeatCount === undefined ? 1 : Number(b.repeatCount),
        days = b.repeatEveryDays === undefined ? 7 : Number(b.repeatEveryDays);
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > 52 ||
        !Number.isInteger(days) ||
        days < 1 ||
        days > 365
      )
        fail(
          400,
          "VALIDATION_ERROR",
          "반복은 1~52회, 간격은 1~365일로 설정해주세요.",
        );
      const seriesId = count > 1 ? randomUUID() : null;
      const rows = Array.from({ length: count }, (_, i) => ({
        seriesId,
        seriesIndex: seriesId ? i : null,
        id: i === 0 ? requestId : undefined,
        ...values,
        programId: id,
        title: count > 1 ? `${values.title} · ${i + 1}회` : values.title,
        startsAt: new Date(+startsAt + i * days * 86400000),
        endsAt: new Date(+endsAt + i * days * 86400000),
      }));
      return (await tx.insert(sessions).values(rows).returning())[0];
    });
  }
  async removeMember(u: User, pid: string, target: string) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      if (target !== u.id && !a.permissions.includes("study.members.remove"))
        fail(403, "FORBIDDEN", "회원 관리 권한이 필요합니다.");
      const [project] = await tx
        .select()
        .from(projects)
        .where(eq(projects.id, pid));
      if (project.createdBy === target)
        fail(
          409,
          "OWNER_PROTECTED",
          "공간 관리자는 탈퇴하거나 제거할 수 없습니다.",
        );
      await this.checkMembers(tx, pid, [uuid(target)]);
      const ps = await tx
        .select()
        .from(programs)
        .where(eq(programs.projectId, pid));
      const ids = ps.map((p) => p.id);
      if (ids.length) {
        await tx
          .update(members)
          .set({ leftAt: new Date() })
          .where(
            and(inArray(members.programId, ids), eq(members.userId, target)),
          );
        await tx
          .delete(organizers)
          .where(
            and(
              inArray(organizers.programId, ids),
              eq(organizers.userId, target),
            ),
          );
        const ss = await tx
          .select()
          .from(sessions)
          .where(inArray(sessions.programId, ids));
        if (ss.length)
          await tx
            .update(liveConnections)
            .set({ leftAt: new Date() })
            .where(
              and(
                inArray(
                  liveConnections.sessionId,
                  ss.map((s) => s.id),
                ),
                eq(liveConnections.userId, target),
                isNull(liveConnections.leftAt),
              ),
            );
      }
      await tx
        .delete(projectMemberRoles)
        .where(
          and(
            eq(projectMemberRoles.projectId, pid),
            eq(projectMemberRoles.userId, target),
          ),
        );
      await tx
        .delete(pm)
        .where(and(eq(pm.projectId, pid), eq(pm.userId, target)));
      return { ok: true };
    });
  }
  async setDeputy(
    u: User,
    pid: string,
    target: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      if (!a.isOwner)
        fail(403, "FORBIDDEN", "관리자만 부관리자를 지정할 수 있습니다.");
      if (target === u.id)
        fail(409, "OWNER_PROTECTED", "관리자 역할은 변경할 수 없습니다.");
      await this.checkMembers(tx, pid, [uuid(target)]);
      if (typeof b.deputy !== "boolean")
        fail(400, "VALIDATION_ERROR", "역할을 확인해주세요.");
      const roles = await tx
        .select()
        .from(projectRoles)
        .where(eq(projectRoles.projectId, pid));
      const deputy = roles.find((r) => r.name === studyRoleTemplates()[1].name);
      if (!deputy) fail(409, "ROLE_MISSING", "기본 역할을 찾을 수 없습니다.");
      if (b.deputy)
        await tx
          .insert(projectMemberRoles)
          .values({ projectId: pid, userId: target, roleId: deputy!.id })
          .onConflictDoNothing();
      else
        await tx
          .delete(projectMemberRoles)
          .where(
            and(
              eq(projectMemberRoles.projectId, pid),
              eq(projectMemberRoles.userId, target),
              eq(projectMemberRoles.roleId, deputy!.id),
            ),
          );
      return { ok: true };
    });
  }
  async saveRole(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, "study.roles.manage");
      const defaults = studyRoleTemplates();
      const [existing] = id
        ? await tx
            .select()
            .from(projectRoles)
            .where(
              and(
                eq(projectRoles.projectId, pid),
                eq(projectRoles.id, uuid(id)),
              ),
            )
        : [];
      if (id && !existing) fail(404, "NOT_FOUND", "역할을 찾을 수 없습니다.");
      const base = defaults.find((r) => r.name === existing?.name);
      if (base && (!a.isOwner || base.name === "관리자"))
        fail(403, "FORBIDDEN", "이 기본 역할은 변경할 수 없습니다.");
      if (
        existing &&
        !a.isOwner &&
        existing.permissions.some((p) => !a.permissions.includes(p))
      )
        fail(
          403,
          "FORBIDDEN",
          "본인 권한을 넘어서는 역할은 변경할 수 없습니다.",
        );
      if (b.action === "delete") {
        if (!existing || base)
          fail(409, "ROLE_PROTECTED", "기본 역할은 삭제할 수 없습니다.");
        await tx.delete(projectRoles).where(eq(projectRoles.id, id!));
        return { ok: true };
      }
      if (b.action === "reset") {
        if (!existing || !base || !a.isOwner)
          fail(403, "FORBIDDEN", "기본 역할만 관리자가 초기화할 수 있습니다.");
        const [stored] = await tx
          .select()
          .from(roleDefaults)
          .where(eq(roleDefaults.roleId, id!));
        if (!stored)
          fail(409, "DEFAULT_MISSING", "생성 당시 기본값을 찾을 수 없습니다.");
        return (
          await tx
            .update(projectRoles)
            .set({ permissions: JSON.parse(stored.permissions) as string[] })
            .where(eq(projectRoles.id, id!))
            .returning()
        )[0];
      }
      if (b.action !== undefined)
        fail(400, "VALIDATION_ERROR", "처리 방식을 확인해주세요.");
      const name = base ? base.name : bounded(b.name, 60);
      if (!base && defaults.some((r) => r.name === name))
        fail(400, "VALIDATION_ERROR", "기본 역할 이름은 사용할 수 없습니다.");
      if (
        !Array.isArray(b.permissions) ||
        b.permissions.some(
          (p) =>
            typeof p !== "string" ||
            !(studyPermissions as readonly string[]).includes(p),
        )
      )
        fail(400, "VALIDATION_ERROR", "권한을 확인해주세요.");
      const permissions = [...new Set(b.permissions as string[])];
      if (
        !a.isOwner &&
        permissions.some(
          (p) =>
            !a.permissions.includes(p) ||
            ["study.roles.manage", "study.roles.assign"].includes(p),
        )
      )
        fail(
          403,
          "FORBIDDEN",
          "본인 권한 또는 위임 범위를 넘어설 수 없습니다.",
        );
      if (existing)
        return (
          await tx
            .update(projectRoles)
            .set({ name, permissions })
            .where(eq(projectRoles.id, id!))
            .returning()
        )[0];
      return (
        await tx
          .insert(projectRoles)
          .values({ projectId: pid, name, permissions })
          .returning()
      )[0];
    });
  }
  async assignRoles(
    u: User,
    pid: string,
    target: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, "study.roles.assign");
      await this.checkMembers(tx, pid, [uuid(target)]);
      const [p] = await tx.select().from(projects).where(eq(projects.id, pid));
      if (target === p.createdBy)
        fail(403, "FORBIDDEN", "관리자의 역할은 변경할 수 없습니다.");
      const ids = this.ids(b.roleIds);
      const roles = await tx
        .select()
        .from(projectRoles)
        .where(eq(projectRoles.projectId, pid));
      if (ids.some((id) => !roles.some((r) => r.id === id)))
        fail(400, "VALIDATION_ERROR", "다른 프로젝트의 역할입니다.");
      const current = await tx
        .select()
        .from(projectMemberRoles)
        .where(
          and(
            eq(projectMemberRoles.projectId, pid),
            eq(projectMemberRoles.userId, target),
          ),
        );
      const changed = roles.filter(
        (r) => ids.includes(r.id) !== current.some((c) => c.roleId === r.id),
      );
      for (const r of changed) {
        if (r.name === "관리자")
          fail(403, "FORBIDDEN", "관리자 지위는 부여할 수 없습니다.");
        if (
          !a.isOwner &&
          (studyRoleTemplates().some((b) => b.name === r.name) ||
            r.permissions.some(
              (p) =>
                !a.permissions.includes(p) ||
                ["study.roles.manage", "study.roles.assign"].includes(p),
            ))
        )
          fail(403, "FORBIDDEN", "이 역할을 부여/회수할 수 없습니다.");
      }
      await tx
        .delete(projectMemberRoles)
        .where(
          and(
            eq(projectMemberRoles.projectId, pid),
            eq(projectMemberRoles.userId, target),
          ),
        );
      if (ids.length)
        await tx
          .insert(projectMemberRoles)
          .values(
            ids.map((roleId) => ({ projectId: pid, userId: target, roleId })),
          );
      return { ok: true };
    });
  }

  async createActivity(
    u: User,
    pid: string,
    programId: string,
    b: Record<string, unknown>,
    activityId?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      const p = await this.program(tx, pid, programId);
      const [host] = await tx
        .select()
        .from(organizers)
        .where(
          and(eq(organizers.programId, programId), eq(organizers.userId, u.id)),
        );
      if (!host && !a.permissions.includes("study.activities.manage"))
        fail(403, "FORBIDDEN", "활동 관리 권한이 필요합니다.");
      if ((!activityId && p.status !== "active") || p.archivedAt)
        fail(
          409,
          "STATE_CONFLICT",
          "프로그램을 시작한 뒤 활동을 등록해주세요.",
        );
      if (activityId) {
        const [current] = await tx
          .select()
          .from(activities)
          .where(
            and(
              eq(activities.id, uuid(activityId)),
              eq(activities.programId, programId),
            ),
          )
          .for("update");
        if (!current) fail(404, "NOT_FOUND", "활동을 찾을 수 없습니다.");
        if (b.action === "archive" || b.action === "restore")
          return (
            await tx
              .update(activities)
              .set({ archivedAt: b.action === "archive" ? new Date() : null })
              .where(eq(activities.id, activityId))
              .returning()
          )[0];
        if (b.action === "delete") {
          const records = await tx
            .select()
            .from(submissions)
            .where(eq(submissions.activityId, activityId));
          if (records.length)
            fail(
              409,
              "HAS_SUBMISSIONS",
              "제출 기록이 있어 삭제할 수 없습니다. 활동을 보관해주세요.",
            );
          await tx.delete(activities).where(eq(activities.id, activityId));
          return { id: activityId, deleted: true };
        }
      }
      const dueAt = new Date(String(b.dueAt));
      if (!Number.isFinite(+dueAt))
        fail(400, "VALIDATION_ERROR", "마감을 확인해주세요.");
      const latePolicy = b.latePolicy ?? "allow";
      if (!["allow", "block"].includes(latePolicy as string))
        fail(400, "VALIDATION_ERROR", "제출 정책을 확인해주세요.");
      const sessionId = b.sessionId ? uuid(b.sessionId) : null;
      if (sessionId) {
        const [s] = await tx
          .select()
          .from(sessions)
          .where(
            and(eq(sessions.id, sessionId), eq(sessions.programId, programId)),
          );
        if (!s)
          fail(
            400,
            "VALIDATION_ERROR",
            "같은 프로그램의 회차만 연결할 수 있습니다.",
          );
      }
      const values = {
        programId,
        sessionId,
        title: bounded(b.title, 120),
        instructions: bounded(b.instructions ?? "", 10000, false),
        dueAt,
        latePolicy: String(latePolicy),
      };
      if (activityId)
        return (
          await tx
            .update(activities)
            .set(values)
            .where(eq(activities.id, activityId))
            .returning()
        )[0];
      return (await tx.insert(activities).values(values).returning())[0];
    });
  }
  async activityDetail(u: User, pid: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid);
      const [activity] = await tx
        .select()
        .from(activities)
        .where(eq(activities.id, uuid(id)));
      if (!activity) fail(404, "NOT_FOUND", "활동을 찾을 수 없습니다.");
      const p = await this.program(tx, pid, activity.programId);
      const [host] = await tx
        .select()
        .from(organizers)
        .where(
          and(eq(organizers.programId, p.id), eq(organizers.userId, u.id)),
        );
      const targets = await tx
        .select({
          userId: members.userId,
          displayName: users.displayName,
          leftAt: members.leftAt,
        })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(eq(members.programId, p.id));
      const canRead =
        !!host || a.permissions.includes("study.submissions.read");
      if (!canRead && !targets.some((t) => t.userId === u.id && !t.leftAt))
        fail(403, "FORBIDDEN", "활동 참여 대상이 아닙니다.");
      const versions = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.activityId, id),
            canRead ? undefined : eq(submissions.userId, u.id),
          ),
        )
        .orderBy(asc(submissions.submittedAt));
      const versionIds = versions.map((v) => v.id);
      const files = versionIds.length
        ? await tx
            .select({
              submissionId: submissionAssets.submissionId,
              id: assets.id,
              name: assets.originalName,
              mime: assets.mime,
              size: assets.size,
            })
            .from(submissionAssets)
            .innerJoin(assets, eq(assets.id, submissionAssets.assetId))
            .where(inArray(submissionAssets.submissionId, versionIds))
        : [];
      return {
        activity,
        archived: !!p.archivedAt || !!activity.archivedAt,
        canRead,
        targets: canRead ? targets : targets.filter((t) => t.userId === u.id),
        versions: versions.map((v) => ({
          ...v,
          bodyDocument: v.bodyDocument ? JSON.parse(v.bodyDocument) : null,
          files: files.filter((f) => f.submissionId === v.id),
        })),
      };
    });
  }
  async submit(u: User, pid: string, id: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const [activity] = await tx
        .select()
        .from(activities)
        .where(eq(activities.id, uuid(id)))
        .for("update");
      if (!activity) fail(404, "NOT_FOUND", "활동을 찾을 수 없습니다.");
      const p = await this.program(tx, pid, activity.programId);
      if (p.archivedAt || activity.archivedAt)
        fail(409, "ARCHIVED", "보관된 프로그램·활동에는 제출할 수 없습니다.");
      const [target] = await tx
        .select()
        .from(members)
        .where(
          and(
            eq(members.programId, p.id),
            eq(members.userId, u.id),
            isNull(members.leftAt),
          ),
        );
      if (!target) fail(403, "FORBIDDEN", "활동 참여 대상이 아닙니다.");
      const requestId = b.requestId ? uuid(b.requestId) : undefined;
      if (requestId) {
        const [existing] = await tx
          .select()
          .from(submissions)
          .where(eq(submissions.id, requestId));
        if (existing) {
          if (existing.activityId !== id || existing.userId !== u.id)
            fail(409, "REQUEST_CONFLICT", "제출 요청을 다시 시작해주세요.");
          return existing;
        }
      }
      const submittedAt = new Date();
      if (activity.latePolicy === "block" && submittedAt > activity.dueAt)
        fail(409, "DEADLINE_PASSED", "마감 후 제출이 차단된 활동입니다.");
      const assetIds = this.ids(b.assetIds ?? []);
      if (assetIds.length > 10)
        fail(400, "VALIDATION_ERROR", "파일은 최대 10개입니다.");
      if (assetIds.length) {
        const files = await tx
          .select()
          .from(assets)
          .where(
            and(
              eq(assets.projectId, pid),
              eq(assets.ownerId, u.id),
              inArray(assets.id, assetIds),
            ),
          );
        if (files.length !== assetIds.length)
          fail(403, "FORBIDDEN", "본인이 업로드한 파일만 제출할 수 있습니다.");
      }
      const bodyDocument = parseRichDocument(b.bodyDocument);
      const body = bounded(
        bodyDocument ? richDocumentText(bodyDocument) : (b.body ?? ""),
        10000,
        assetIds.length === 0,
      );
      const [version] = await tx
        .insert(submissions)
        .values({
          id: requestId,
          activityId: id,
          userId: u.id,
          body,
          deadlineAt: activity.dueAt,
          bodyDocument: bodyDocument ? JSON.stringify(bodyDocument) : null,
          submittedAt,
        })
        .returning();
      if (assetIds.length)
        await tx
          .insert(submissionAssets)
          .values(
            assetIds.map((assetId) => ({ submissionId: version.id, assetId })),
          );
      return version;
    });
  }
}
