import { Injectable } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, ne, or } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { users } from "../db/schema/auth.js";
import {
  teams,
  teamMemberships as tm,
  teamMemberPositions as pos,
  projects,
  projectMemberships as pm,
  invitations,
} from "../db/schema/workspace.js";
import { fail } from "../auth/security.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail(
      400,
      "VALIDATION_ERROR",
      "올바른 사용자 또는 프로젝트 ID를 입력해주세요.",
    );
  return value as string;
}
export function bounded(value: unknown, max: number, required = true): string {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (required && !value.trim())
  )
    fail(
      400,
      "VALIDATION_ERROR",
      `입력은 ${required ? "1" : "0"}~${max}자로 작성해주세요.`,
    );
  return (value as string).trim();
}
export function canManageMember(actor: string, target: string, next: string) {
  return (
    (actor === "owner" &&
      target !== "owner" &&
      ["admin", "member"].includes(next)) ||
    (actor === "admin" && target === "member" && next === "member")
  );
}
export function invitationAvailable(
  status: string | undefined,
  accountType: string | undefined,
  role: string | undefined,
  projectMember: boolean,
) {
  return (
    status === "active" &&
    accountType === "team" &&
    ["owner", "admin"].includes(role ?? "") &&
    projectMember
  );
}
@Injectable()
export class WorkspaceService {
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }
  private teamUser(u: User) {
    if (u.accountType !== "team")
      fail(403, "FORBIDDEN", "개발팀 계정만 사용할 수 있습니다.");
  }
  private async manager(tx: Tx, u: User, projectId: string) {
    this.teamUser(u);
    const [p] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, uuid(projectId)));
    if (!p) fail(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    await tx.select().from(teams).where(eq(teams.id, p.teamId)).for("update");
    const [t] = await tx
      .select()
      .from(tm)
      .where(and(eq(tm.teamId, p.teamId), eq(tm.userId, u.id)));
    const [m] = await tx
      .select()
      .from(pm)
      .where(and(eq(pm.projectId, p.id), eq(pm.userId, u.id)));
    if (!t || !m || !["owner", "admin"].includes(t.permissionRole))
      fail(403, "FORBIDDEN", "프로젝트 관리 권한이 필요합니다.");
    return p;
  }
  async snapshot(u: User) {
    const mine = await this.db.select().from(tm).where(eq(tm.userId, u.id));
    const teamIds = mine.map((t) => t.teamId);
    const adminIds = mine
      .filter((t) => ["owner", "admin"].includes(t.permissionRole))
      .map((t) => t.teamId);
    const joined = await this.db.select().from(pm).where(eq(pm.userId, u.id));
    const pids = joined.map((p) => p.projectId);
    const ps = pids.length
      ? await this.db.select().from(projects).where(inArray(projects.id, pids))
      : [];
    const visiblePids = ps.map((p) => p.id);
    const visibleTids = [...new Set([...teamIds, ...ps.map((p) => p.teamId)])];
    const tms = visibleTids.length
      ? await this.db
          .select({ m: tm, u: users })
          .from(tm)
          .innerJoin(users, eq(tm.userId, users.id))
          .where(inArray(tm.teamId, visibleTids))
      : [];
    const positions = visibleTids.length
      ? await this.db.select().from(pos).where(inArray(pos.teamId, visibleTids))
      : [];
    const pms = visiblePids.length
      ? await this.db
          .select({ m: pm, u: users })
          .from(pm)
          .innerJoin(users, eq(pm.userId, users.id))
          .where(inArray(pm.projectId, visiblePids))
      : [];
    const member = (user: User, tid: string, accessRole: string | null) => ({
      userId: user.id,
      displayName: user.displayName,
      accountType: user.accountType,
      positions: positions
        .filter((p) => p.teamId === tid && p.userId === user.id)
        .map((p) => p.position),
      permissionRole:
        tms.find((t) => t.m.teamId === tid && t.u.id === user.id)?.m
          .permissionRole ?? null,
      accessRole,
    });
    const ts = teamIds.length
      ? await this.db.select().from(teams).where(inArray(teams.id, teamIds))
      : [];
    const invs = await this.db
      .select({ i: invitations, p: projects })
      .from(invitations)
      .innerJoin(projects, eq(invitations.projectId, projects.id))
      .where(
        or(
          eq(invitations.inviteeId, u.id),
          eq(invitations.inviterId, u.id),
          visiblePids.length && adminIds.length
            ? and(
                inArray(projects.id, visiblePids),
                inArray(projects.teamId, adminIds),
              )
            : undefined,
        ),
      );
    const ids = [
      ...new Set(invs.flatMap((x) => [x.i.inviterId, x.i.inviteeId])),
    ];
    const people = ids.length
      ? await this.db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    return {
      userId: u.id,
      teams: ts.map((t) => ({
        ...t,
        permissionRole: mine.find((m) => m.teamId === t.id)!.permissionRole,
        members: tms
          .filter((m) => m.m.teamId === t.id)
          .map((m) => member(m.u, t.id, null)),
      })),
      projects: ps.map((p) => ({
        ...p,
        canManage: u.accountType === "team" && adminIds.includes(p.teamId),
        members: pms
          .filter((m) => m.m.projectId === p.id)
          .map((m) => member(m.u, p.teamId, m.m.accessRole)),
      })),
      invitations: invs.map(({ i, p }) => ({
        ...i,
        projectName: p.name,
        projectDescription: p.description,
        inviterName:
          people.find((x) => x.id === i.inviterId)?.displayName ?? "",
        inviteeName:
          people.find((x) => x.id === i.inviteeId)?.displayName ?? "",
        direction: i.inviteeId === u.id ? "received" : "sent",
      })),
    };
  }
  async searchUsers(u: User, query: unknown, accountType: unknown) {
    this.teamUser(u);
    const term = bounded(query, 100);
    if (term.length < 2 || !["client", "team"].includes(accountType as string))
      fail(
        400,
        "VALIDATION_ERROR",
        "이름은 2자 이상 입력하고 초대할 계정 유형을 선택해주세요.",
      );
    const isId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        term,
      );
    // Escape LIKE wildcards so names containing %, _ or backslashes are literal.
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const matches = await this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        accountType: users.accountType,
      })
      .from(users)
      .where(
        and(
          eq(users.status, "active"),
          eq(users.accountType, accountType as string),
          ne(users.id, u.id),
          isId ? eq(users.id, term) : ilike(users.displayName, pattern),
        ),
      )
      .orderBy(asc(users.displayName), asc(users.id))
      .limit(20);
    return { users: matches };
  }
  async lookup(u: User, id: string) {
    this.teamUser(u);
    const [target] = await this.db
      .select({
        id: users.id,
        displayName: users.displayName,
        accountType: users.accountType,
      })
      .from(users)
      .where(and(eq(users.id, uuid(id)), eq(users.status, "active")));
    if (!target)
      fail(404, "USER_NOT_FOUND", "가입된 사용자를 찾을 수 없습니다.");
    return target;
  }
  async create(u: User, body: Record<string, unknown>) {
    this.teamUser(u);
    const name = bounded(body?.name, 120);
    const description = bounded(body?.description ?? "", 2000, false);
    const requested =
      body?.teamId === undefined ? undefined : uuid(body.teamId);
    const rawInvitees = body?.inviteeIds === undefined ? [] : body.inviteeIds;
    if (!Array.isArray(rawInvitees) || rawInvitees.length > 20)
      fail(
        400,
        "VALIDATION_ERROR",
        "초대할 사용자는 최대 20명까지 선택해주세요.",
      );
    const inviteeIds = (rawInvitees as unknown[]).map((id) =>
      uuid(id).toLowerCase(),
    );
    if (new Set(inviteeIds).size !== inviteeIds.length)
      fail(400, "VALIDATION_ERROR", "초대할 사용자가 중복되었습니다.");
    if (inviteeIds.includes(u.id.toLowerCase()))
      fail(409, "ALREADY_MEMBER", "본인은 프로젝트에 자동으로 참여합니다.");
    return this.db.transaction(async (tx) => {
      // Serialize first-project creation so simultaneous submissions share one personal team.
      await tx.select().from(users).where(eq(users.id, u.id)).for("update");
      if (inviteeIds.length) {
        const targets = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(inArray(users.id, inviteeIds), eq(users.status, "active")),
          );
        if (targets.length !== inviteeIds.length)
          fail(
            404,
            "USER_NOT_FOUND",
            "초대 대상 중 가입된 활성 사용자를 찾을 수 없습니다.",
          );
      }
      let teamId = requested;
      if (teamId) {
        await tx.select().from(teams).where(eq(teams.id, teamId)).for("update");
        const [m] = await tx
          .select()
          .from(tm)
          .where(and(eq(tm.teamId, teamId), eq(tm.userId, u.id)));
        if (!m || !["owner", "admin"].includes(m.permissionRole))
          fail(403, "FORBIDDEN", "팀 관리 권한이 필요합니다.");
      } else {
        const [existing] = await tx
          .select()
          .from(tm)
          .where(and(eq(tm.userId, u.id), eq(tm.permissionRole, "owner")));
        teamId = existing?.teamId;
        if (!teamId) {
          const [t] = await tx
            .insert(teams)
            .values({ name: `${u.displayName}의 팀`, createdBy: u.id })
            .returning();
          teamId = t.id;
          await tx
            .insert(tm)
            .values({ teamId, userId: u.id, permissionRole: "owner" });
        }
      }
      const [p] = await tx
        .insert(projects)
        .values({ name, description, teamId, createdBy: u.id })
        .returning();
      await tx
        .insert(pm)
        .values({ projectId: p.id, userId: u.id, accessRole: "manager" });
      if (inviteeIds.length)
        await tx.insert(invitations).values(
          inviteeIds.map((inviteeId) => ({
            projectId: p.id,
            inviterId: u.id,
            inviteeId,
          })),
        );
      return p;
    });
  }
  async update(u: User, id: string, body: Record<string, unknown>) {
    const patch: Partial<typeof projects.$inferInsert> = {};
    if (body?.name !== undefined) patch.name = bounded(body.name, 120);
    if (body?.description !== undefined)
      patch.description = bounded(body.description, 2000, false);
    if (body?.status !== undefined) {
      if (
        !["preparing", "in_progress", "completed"].includes(
          body.status as string,
        )
      )
        fail(400, "VALIDATION_ERROR", "프로젝트 상태를 확인해주세요.");
      patch.status = body.status as string;
    }
    if (!Object.keys(patch).length)
      fail(400, "VALIDATION_ERROR", "변경할 내용을 입력해주세요.");
    return this.db.transaction(async (tx) => {
      await this.manager(tx, u, id);
      return (
        await tx
          .update(projects)
          .set(patch)
          .where(eq(projects.id, id))
          .returning()
      )[0];
    });
  }
  async invite(u: User, id: string, body: Record<string, unknown>) {
    const inviteeId = uuid(body?.userId);
    return this.db.transaction(async (tx) => {
      const p = await this.manager(tx, u, id);
      await tx
        .select()
        .from(projects)
        .where(eq(projects.id, p.id))
        .for("update");
      const [target] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, inviteeId), eq(users.status, "active")));
      if (!target)
        fail(404, "USER_NOT_FOUND", "가입된 사용자를 찾을 수 없습니다.");
      const [member] = await tx
        .select()
        .from(pm)
        .where(and(eq(pm.projectId, p.id), eq(pm.userId, inviteeId)));
      if (member || inviteeId === u.id)
        fail(409, "ALREADY_MEMBER", "이미 참여 중인 사용자입니다.");
      const [pending] = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.projectId, p.id),
            eq(invitations.inviteeId, inviteeId),
            eq(invitations.status, "pending"),
          ),
        );
      if (pending)
        fail(409, "INVITATION_PENDING", "이미 보낸 초대가 있습니다.");
      return (
        await tx
          .insert(invitations)
          .values({ projectId: p.id, inviterId: u.id, inviteeId })
          .returning()
      )[0];
    });
  }
  async respond(u: User, id: string, body: Record<string, unknown>) {
    uuid(id);
    const action = body?.action;
    if (!["accept", "decline", "cancel"].includes(action as string))
      fail(400, "VALIDATION_ERROR", "초대 처리 방식을 확인해주세요.");
    return this.db.transaction(async (tx) => {
      const [initial] = await tx
        .select({ teamId: projects.teamId })
        .from(invitations)
        .innerJoin(projects, eq(projects.id, invitations.projectId))
        .where(eq(invitations.id, id));
      if (!initial) fail(404, "NOT_FOUND", "초대를 찾을 수 없습니다.");
      await tx
        .select()
        .from(teams)
        .where(eq(teams.id, initial.teamId))
        .for("update");
      const [i] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.id, id))
        .for("update");
      if (!i) fail(404, "NOT_FOUND", "초대를 찾을 수 없습니다.");
      if (action === "cancel") await this.manager(tx, u, i.projectId);
      else if (i.inviteeId !== u.id)
        fail(403, "FORBIDDEN", "본인에게 온 초대만 처리할 수 있습니다.");
      const status =
        action === "accept"
          ? "accepted"
          : action === "decline"
            ? "declined"
            : "canceled";
      if (i.status === status) return i;
      if (i.status !== "pending")
        fail(409, "INVITATION_PROCESSED", "이미 처리된 초대입니다.");
      if (action === "accept") {
        const [inviter] = await tx
          .select({ status: users.status, accountType: users.accountType })
          .from(users)
          .where(eq(users.id, i.inviterId));
        const [inviterTeam] = await tx
          .select()
          .from(tm)
          .where(
            and(eq(tm.teamId, initial.teamId), eq(tm.userId, i.inviterId)),
          );
        const [inviterProject] = await tx
          .select()
          .from(pm)
          .where(
            and(eq(pm.projectId, i.projectId), eq(pm.userId, i.inviterId)),
          );
        if (
          !invitationAvailable(
            inviter?.status,
            inviter?.accountType,
            inviterTeam?.permissionRole,
            Boolean(inviterProject),
          )
        )
          fail(
            409,
            "INVITATION_UNAVAILABLE",
            "초대한 사람의 권한이 변경되었습니다. 관리자에게 새 초대를 요청해주세요.",
          );
        const [p] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, i.projectId));
        if (u.accountType === "team")
          await tx
            .insert(tm)
            .values({
              teamId: p.teamId,
              userId: u.id,
              permissionRole: "member",
            })
            .onConflictDoNothing();
        await tx
          .insert(pm)
          .values({
            projectId: p.id,
            userId: u.id,
            accessRole: u.accountType === "team" ? "contributor" : "client",
          })
          .onConflictDoNothing();
      }
      return (
        await tx
          .update(invitations)
          .set({ status, respondedAt: new Date() })
          .where(eq(invitations.id, id))
          .returning()
      )[0];
    });
  }
  async member(
    u: User,
    teamId: string,
    userId: string,
    body: Record<string, unknown>,
  ) {
    this.teamUser(u);
    uuid(teamId);
    uuid(userId);
    const values = body?.positions;
    if (
      values !== undefined &&
      (!Array.isArray(values) ||
        values.length > 3 ||
        values.some((p) => !["planner", "designer", "developer"].includes(p)) ||
        new Set(values).size !== values.length)
    )
      fail(400, "VALIDATION_ERROR", "직무를 확인해주세요.");
    if (
      body?.permissionRole !== undefined &&
      !["admin", "member"].includes(body.permissionRole as string)
    )
      fail(400, "VALIDATION_ERROR", "관리 역할을 확인해주세요.");
    if (values === undefined && body?.permissionRole === undefined)
      fail(400, "VALIDATION_ERROR", "변경할 내용을 입력해주세요.");
    return this.db.transaction(async (tx) => {
      await tx.select().from(teams).where(eq(teams.id, teamId)).for("update");
      const rows = await tx.select().from(tm).where(eq(tm.teamId, teamId));
      const actor = rows.find((m) => m.userId === u.id),
        target = rows.find((m) => m.userId === userId);
      if (!actor || !["owner", "admin"].includes(actor.permissionRole))
        return fail(403, "FORBIDDEN", "팀 관리 권한이 필요합니다.");
      if (!target) return fail(404, "NOT_FOUND", "팀원을 찾을 수 없습니다.");
      const next = (body.permissionRole ?? target.permissionRole) as string;
      // Owner may edit their own positions, but ownership cannot be changed here.
      const ownPositions =
        actor.permissionRole === "owner" &&
        target.userId === u.id &&
        body.permissionRole === undefined;
      if (
        !ownPositions &&
        !canManageMember(actor.permissionRole, target.permissionRole, next)
      )
        fail(
          403,
          "FORBIDDEN",
          "이 멤버의 직무 또는 권한을 변경할 수 없습니다.",
        );
      if (body.permissionRole !== undefined)
        await tx
          .update(tm)
          .set({ permissionRole: next })
          .where(and(eq(tm.teamId, teamId), eq(tm.userId, userId)));
      if (values !== undefined) {
        await tx
          .delete(pos)
          .where(and(eq(pos.teamId, teamId), eq(pos.userId, userId)));
        if ((values as string[]).length)
          await tx.insert(pos).values(
            (values as string[]).map((position) => ({
              teamId,
              userId,
              position,
            })),
          );
      }
      return { userId, permissionRole: next, positions: values };
    });
  }
}
