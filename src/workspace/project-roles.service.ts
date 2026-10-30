import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  projects,
  teams,
  projectMemberships as pm,
  teamMemberships as tm,
} from "../db/schema/workspace.js";
import {
  projectRoles as roles,
  projectMemberRoles as assigned,
} from "../db/schema/project-roles.js";
import { fail } from "../auth/security.js";
import { uuid } from "./workspace.service.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
type User = { id: string; accountType: string };
export const permissionCatalog = [
  ["requests.read", "요청 조회", "요청"],
  ["requests.create", "개발 요청 작성", "요청"],
  ["meetings.read", "회의 조회", "회의"],
  ["meetings.create", "회의 생성", "회의"],
  ["meetings.update", "회의 수정", "회의"],
  ["documents.read", "문서 조회", "문서"],
  ["documents.create", "문서 생성", "문서"],
  ["documents.update", "문서 수정", "문서"],
  ["tasks.read", "업무 조회", "업무"],
  ["tasks.assign", "업무 배정", "업무"],
  ["tasks.progress", "배정된 업무 진행", "업무"],
  ["approvals.tasks", "회의 최종 승인", "승인"],
  ["approvals.merge", "병합 승인", "승인"],
  ["approvals.work", "작업 승인", "승인"],
  ["deploy.run", "배포하기", "배포"],
  ["members.manage", "참여자 관리", "관리"],
  ["roles.manage", "역할·권한 관리", "관리"],
  ["project.settings", "프로젝트 설정", "관리"],
  ["activity.read", "활동 기록 조회", "활동 기록"],
].map(([id, label, group]) => ({ id: id!, label: label!, group: group! }));
export const allProjectPermissions = permissionCatalog.map((p) => p.id);
export function normalizeProjectPermissions(values: string[]) {
  const permissions = [...new Set(values)];
  for (const area of ["requests", "meetings", "documents", "tasks"]) {
    if (
      permissions.some((p) => p.startsWith(area + ".")) &&
      !permissions.includes(area + ".read")
    )
      permissions.push(area + ".read");
  }
  if (
    permissions.some((p) =>
      ["approvals.merge", "approvals.work", "deploy.run"].includes(p),
    ) &&
    !permissions.includes("tasks.read")
  )
    permissions.push("tasks.read");
  if (
    permissions.includes("approvals.tasks") &&
    !permissions.includes("requests.read")
  )
    permissions.push("requests.read");
  return permissions;
}
export function effectivePermissions(input: {
  isDeveloper: boolean;
  isOwner: boolean;
  rolesConfigured: boolean;
  rolePermissions: string[];
  isAdmin: boolean;
  canApproveTasks: boolean;
  canApproveMerge: boolean;
}) {
  if (!input.isDeveloper) return [];
  if (input.isOwner) return [...allProjectPermissions];
  if (input.rolesConfigured)
    return allProjectPermissions.filter((p) =>
      normalizeProjectPermissions(input.rolePermissions).includes(p),
    );
  return allProjectPermissions.filter(
    (p) =>
      ![
        "tasks.assign",
        "members.manage",
        "roles.manage",
        "project.settings",
        "approvals.tasks",
        "approvals.merge",
        "approvals.work",
        "deploy.run",
      ].includes(p) ||
      ([
        "tasks.assign",
        "members.manage",
        "roles.manage",
        "project.settings",
      ].includes(p) &&
        input.isAdmin) ||
      (p === "approvals.tasks" && (input.isAdmin || input.canApproveTasks)) ||
      (p === "approvals.merge" && input.canApproveMerge),
  );
}
export async function resolveProjectPermissions(
  tx: Tx,
  u: User,
  pid: string,
  lock = false,
) {
  const [m] = await tx
    .select({
      role: pm.accessRole,
      teamId: projects.teamId,
      rolesConfigured: pm.rolesConfigured,
      canApproveTasks: pm.canApproveTasks,
    })
    .from(pm)
    .innerJoin(projects, eq(projects.id, pm.projectId))
    .where(and(eq(pm.projectId, uuid(pid)), eq(pm.userId, u.id)));
  if (!m) fail(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
  if (lock) {
    await tx.select().from(teams).where(eq(teams.id, m.teamId)).for("update");
    // Membership configuration may have changed while waiting for the team lock.
    const [fresh] = await tx
      .select()
      .from(pm)
      .where(and(eq(pm.projectId, pid), eq(pm.userId, u.id)));
    if (!fresh) fail(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    m.role = fresh.accessRole;
    m.rolesConfigured = fresh.rolesConfigured;
    m.canApproveTasks = fresh.canApproveTasks;
  }
  const [t] = await tx
    .select()
    .from(tm)
    .where(and(eq(tm.teamId, m.teamId), eq(tm.userId, u.id)));
  const isDeveloper = u.accountType === "team" && m.role !== "client" && !!t;
  const isOwner = isDeveloper && t?.permissionRole === "owner";
  const rs = await tx
    .select({ permissions: roles.permissions })
    .from(assigned)
    .innerJoin(
      roles,
      and(
        eq(roles.id, assigned.roleId),
        eq(roles.projectId, assigned.projectId),
      ),
    )
    .where(and(eq(assigned.projectId, pid), eq(assigned.userId, u.id)));
  const permissions = effectivePermissions({
    isDeveloper,
    isOwner,
    rolesConfigured: m.rolesConfigured,
    rolePermissions: rs.flatMap((r) => r.permissions),
    isAdmin: t?.permissionRole === "admin",
    canApproveTasks: m.canApproveTasks,
    canApproveMerge: t?.canApproveMerge ?? false,
  });
  return {
    isDeveloper,
    isOwner,
    permissions,
    rolesConfigured: m.rolesConfigured,
    teamId: m.teamId,
    canManage: isDeveloper,
    canManageRoles: permissions.includes("roles.manage"),
    canApproveTasks: permissions.includes("approvals.tasks"),
    canApproveMerge: permissions.includes("approvals.merge"),
    canAssign: permissions.includes("tasks.assign"),
  };
}
export function roleDefinition(
  body: Record<string, unknown>,
  updating = false,
) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 50)
    fail(400, "INVALID_ROLE", "역할 이름은 1~50자로 입력해주세요.");
  if (
    !Array.isArray(body.permissions) ||
    body.permissions.some(
      (p) => typeof p !== "string" || !allProjectPermissions.includes(p),
    )
  )
    fail(400, "INVALID_PERMISSIONS", "올바른 권한을 선택해주세요.");
  const permissions = normalizeProjectPermissions(body.permissions as string[]);
  if (
    body.color !== undefined &&
    (typeof body.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.color))
  )
    fail(
      400,
      "INVALID_ROLE_COLOR",
      "역할 색상은 #RRGGBB 형식으로 입력해주세요.",
    );
  const color =
    typeof body.color === "string"
      ? body.color.toUpperCase()
      : updating
        ? undefined
        : "#2D63ED";
  return { name, permissions, ...(color === undefined ? {} : { color }) };
}
@Injectable()
export class ProjectRolesService {
  constructor(private readonly database: DatabaseService) {}
  async list(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await resolveProjectPermissions(tx, u, pid);
      if (!access.isDeveloper)
        fail(403, "FORBIDDEN", "개발팀만 역할을 조회할 수 있습니다.");
      const definitions = await tx
        .select()
        .from(roles)
        .where(eq(roles.projectId, pid));
      const memberships = await tx
        .select({ userId: pm.userId, rolesConfigured: pm.rolesConfigured })
        .from(pm)
        .where(
          and(
            eq(pm.projectId, pid),
            inArray(pm.accessRole, ["manager", "contributor"]),
          ),
        );
      const assignments = await tx
        .select()
        .from(assigned)
        .where(eq(assigned.projectId, pid));
      const members = [];
      for (const m of memberships) {
        const a = await resolveProjectPermissions(
          tx,
          { id: m.userId, accountType: "team" },
          pid,
        );
        members.push({
          ...m,
          roleIds: assignments
            .filter((r) => r.userId === m.userId)
            .map((r) => r.roleId),
          permissions: a.permissions,
          isOwner: a.isOwner,
        });
      }
      return {
        roles: definitions,
        catalog: permissionCatalog,
        members,
        permissions: access.permissions,
        isOwner: access.isOwner,
        canManageRoles: access.canManageRoles,
        canManageMembers: access.permissions.includes("members.manage"),
      };
    });
  }
  async save(
    u: User,
    pid: string,
    rid: string | undefined,
    body: Record<string, unknown>,
  ) {
    const value = roleDefinition(body, !!rid);
    return this.database.db.transaction(async (tx) => {
      const a = await resolveProjectPermissions(tx, u, pid, true);
      if (!a.canManageRoles)
        fail(403, "FORBIDDEN", "역할·권한 관리 권한이 필요합니다.");
      const [duplicate] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.projectId, pid), eq(roles.name, value.name)));
      if (duplicate && duplicate.id !== rid)
        fail(409, "ROLE_NAME_EXISTS", "같은 이름의 역할이 있습니다.");
      if (rid) {
        uuid(rid);
        const [role] = await tx
          .update(roles)
          .set(value)
          .where(and(eq(roles.projectId, pid), eq(roles.id, rid)))
          .returning();
        if (!role) fail(404, "NOT_FOUND", "역할을 찾을 수 없습니다.");
        return { role };
      }
      const [role] = await tx
        .insert(roles)
        .values({ projectId: pid, ...value })
        .returning();
      return { role };
    });
  }
  async remove(u: User, pid: string, rid: string) {
    uuid(rid);
    return this.database.db.transaction(async (tx) => {
      const access = await resolveProjectPermissions(tx, u, pid, true);
      if (!access.canManageRoles)
        fail(403, "FORBIDDEN", "역할·권한 관리 권한이 필요합니다.");
      const [role] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.projectId, pid), eq(roles.id, rid)));
      if (!role) fail(404, "NOT_FOUND", "역할을 찾을 수 없습니다.");
      const members = await tx
        .select({ userId: assigned.userId })
        .from(assigned)
        .where(and(eq(assigned.projectId, pid), eq(assigned.roleId, rid)));
      // The FK cascades this role's assignments only. Keep rolesConfigured=true
      // so deleting someone's final role never restores legacy permissions.
      await tx
        .delete(roles)
        .where(and(eq(roles.projectId, pid), eq(roles.id, rid)));
      return { deleted: true, affectedMembers: members.length };
    });
  }
  async assign(
    u: User,
    pid: string,
    uid: string,
    body: Record<string, unknown>,
  ) {
    uuid(uid);
    if (!Array.isArray(body.roleIds) || body.roleIds.length > 100)
      fail(400, "INVALID_ROLES", "역할을 선택해주세요.");
    const ids = [...new Set((body.roleIds as unknown[]).map(uuid))];
    return this.database.db.transaction(async (tx) => {
      const a = await resolveProjectPermissions(tx, u, pid, true);
      // Assigning roles grants privileges, so only role administrators may perform it.
      if (!a.canManageRoles)
        fail(403, "FORBIDDEN", "역할·권한 관리 권한이 필요합니다.");
      const target = await resolveProjectPermissions(
        tx,
        { id: uid, accountType: "team" },
        pid,
      );
      if (!target.isDeveloper)
        fail(
          400,
          "INVALID_MEMBER",
          "개발팀 참여자만 역할을 지정할 수 있습니다.",
        );
      if (target.isOwner)
        fail(400, "OWNER_PROTECTED", "소유자는 모든 권한을 유지합니다.");
      if (ids.length) {
        const found = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.projectId, pid), inArray(roles.id, ids)));
        if (found.length !== ids.length)
          fail(400, "INVALID_ROLES", "이 프로젝트의 역할만 선택해주세요.");
      }
      await tx
        .delete(assigned)
        .where(and(eq(assigned.projectId, pid), eq(assigned.userId, uid)));
      if (ids.length)
        await tx
          .insert(assigned)
          .values(
            ids.map((roleId) => ({ projectId: pid, userId: uid, roleId })),
          );
      await tx
        .update(pm)
        .set({ rolesConfigured: true })
        .where(and(eq(pm.projectId, pid), eq(pm.userId, uid)));
      return { ok: true };
    });
  }
}
