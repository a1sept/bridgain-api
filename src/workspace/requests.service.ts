import { Injectable } from "@nestjs/common";
import { and, eq, inArray, desc, asc, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { users } from "../db/schema/auth.js";
import {
  projects,
  teams,
  projectMemberships as pm,
  teamMemberships as tm,
} from "../db/schema/workspace.js";
import {
  projectRequests as r,
  requestAssignees as a,
  requestEvents as e,
  requestAttachments as f,
} from "../db/schema/requests.js";
import { fail } from "../auth/security.js";
import { uuid, bounded } from "./workspace.service.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export type Upload = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
};
export const transitions: Record<string, string[]> = {
  received: ["in_progress"],
  in_progress: ["review"],
  review: ["revision", "completed"],
  revision: ["in_progress", "review"],
  completed: ["revision", "released"],
  released: ["revision"],
};
export function validateUpload(file: Upload) {
  const b = file.buffer;
  const valid =
    (file.mimetype === "application/pdf" &&
      b.subarray(0, 5).toString() === "%PDF-") ||
    (file.mimetype === "image/png" &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (file.mimetype === "image/jpeg" &&
      b.length > 3 &&
      b[0] === 255 &&
      b[1] === 216 &&
      b[2] === 255);
  if (
    !valid ||
    !file.size ||
    file.size !== b.length ||
    b.length > 20 * 1024 * 1024
  )
    fail(400, "INVALID_FILE", "PDF, PNG, JPG 파일만 첨부할 수 있습니다.");
  return bounded(file.originalname.replace(/[\\/\x00-\x1f\x7f]/g, "_"), 200);
}
@Injectable()
export class RequestsService {
  constructor(private readonly database: DatabaseService) {}
  get db() {
    return this.database.db;
  }
  async access(tx: Tx, u: User, pid: string, lock = false) {
    const [member] = await tx
      .select({ role: pm.accessRole, teamId: projects.teamId })
      .from(pm)
      .innerJoin(projects, eq(projects.id, pm.projectId))
      .where(and(eq(pm.projectId, uuid(pid)), eq(pm.userId, u.id)));
    if (!member) fail(404, "NOT_FOUND", "프로젝트를 찾을 수 없습니다.");
    if (lock)
      await tx
        .select()
        .from(teams)
        .where(eq(teams.id, member.teamId))
        .for("update");
    const [team] = await tx
      .select()
      .from(tm)
      .where(and(eq(tm.teamId, member.teamId), eq(tm.userId, u.id)));
    const canManage =
      u.accountType === "team" && member.role !== "client" && !!team;
    return {
      canManage,
      canAssign:
        canManage && ["owner", "admin"].includes(team?.permissionRole ?? ""),
    };
  }
  private async record(tx: Tx, pid: string, rid: string, lock = false) {
    const q = tx
      .select()
      .from(r)
      .where(and(eq(r.id, uuid(rid)), eq(r.projectId, pid)));
    const [request] = await (lock ? q.for("update") : q);
    if (!request) fail(404, "NOT_FOUND", "요청을 찾을 수 없습니다.");
    return request;
  }
  private async output(tx: Tx, request: typeof r.$inferSelect) {
    const [creator] = await tx
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, request.createdBy));
    const assignees = await tx
      .select({ userId: a.userId, displayName: users.displayName })
      .from(a)
      .innerJoin(users, eq(users.id, a.userId))
      .where(eq(a.requestId, request.id));
    return { ...request, creatorName: creator?.name ?? "", assignees };
  }
  private async files(tx: Tx, pid: string, rid: string) {
    const rows = await tx
      .select({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size })
      .from(f)
      .where(eq(f.requestId, rid));
    return rows.map((x) => ({
      ...x,
      url: `/api/workspace/projects/${pid}/requests/${rid}/attachments/${x.id}`,
    }));
  }
  async list(u: User, pid: string) {
    return this.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const rows = await tx
        .select()
        .from(r)
        .where(eq(r.projectId, pid))
        .orderBy(desc(r.createdAt));
      return {
        requests: await Promise.all(rows.map((x) => this.output(tx, x))),
      };
    });
  }
  async create(u: User, pid: string, b: Record<string, unknown>) {
    const title = bounded(b?.title, 160),
      description = bounded(b?.description, 10000),
      type = bounded(b?.type, 20),
      priority = bounded(b?.priority, 20);
    if (
      !["feature", "bug", "other"].includes(type) ||
      !["urgent", "high", "normal", "low"].includes(priority)
    )
      fail(400, "VALIDATION_ERROR", "요청 유형과 우선순위를 확인해주세요.");
    return this.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const [request] = await tx
        .insert(r)
        .values({
          projectId: pid,
          title,
          description,
          type,
          priority,
          createdBy: u.id,
        })
        .returning();
      await tx.insert(e).values({
        requestId: request.id,
        kind: "created",
        status: "received",
        actorId: u.id,
        createdAt: sql`clock_timestamp()`,
        body: "요청이 접수되었습니다.",
      });
      return { request: await this.output(tx, request) };
    });
  }
  async detail(u: User, pid: string, rid: string) {
    return this.db.transaction(async (tx) => {
      const permissions = await this.access(tx, u, pid);
      const request = await this.record(tx, pid, rid);
      const events = await tx
        .select({
          id: e.id,
          kind: e.kind,
          status: e.status,
          body: e.body,
          actorId: e.actorId,
          actorName: users.displayName,
          createdAt: e.createdAt,
        })
        .from(e)
        .innerJoin(users, eq(users.id, e.actorId))
        .where(eq(e.requestId, rid))
        .orderBy(asc(e.createdAt), asc(e.id));
      return {
        request: await this.output(tx, request),
        events,
        attachments: await this.files(tx, pid, rid),
        ...permissions,
        canUpload: request.createdBy === u.id || permissions.canManage,
      };
    });
  }
  async update(u: User, pid: string, rid: string, b: Record<string, unknown>) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "VALIDATION_ERROR", "변경할 내용을 입력해주세요.");
    return this.db.transaction(async (tx) => {
      const p = await this.access(tx, u, pid, true);
      if (!p.canManage)
        fail(403, "FORBIDDEN", "개발팀 참여자만 변경할 수 있습니다.");
      const request = await this.record(tx, pid, rid, true);
      let changed = false;
      if (b.status === undefined && b.assigneeIds === undefined)
        fail(400, "VALIDATION_ERROR", "변경할 내용을 입력해주세요.");
      if (b.status !== undefined) {
        const status = bounded(b.status, 30);
        if (status !== request.status) {
          changed = true;
          if (!transitions[request.status]?.includes(status))
            fail(
              409,
              "INVALID_TRANSITION",
              "현재 단계에서 변경할 수 없는 상태입니다.",
            );
          await tx.update(r).set({ status }).where(eq(r.id, rid));
          await tx.insert(e).values({
            requestId: rid,
            kind: "status",
            status,
            actorId: u.id,
            createdAt: sql`clock_timestamp()`,
            body: "진행 상태가 변경되었습니다.",
          });
        }
      }
      if (b.assigneeIds !== undefined) {
        if (!p.canAssign)
          fail(
            403,
            "FORBIDDEN",
            "담당자 배정은 프로젝트 관리자가 할 수 있습니다.",
          );
        if (!Array.isArray(b.assigneeIds) || b.assigneeIds.length > 30)
          fail(400, "VALIDATION_ERROR", "담당자를 확인해주세요.");
        const ids = [
          ...new Set(
            (b.assigneeIds as unknown[]).map((x) => uuid(x).toLowerCase()),
          ),
        ];
        const members = ids.length
          ? await tx
              .select({ id: users.id, name: users.displayName })
              .from(pm)
              .innerJoin(users, eq(users.id, pm.userId))
              .innerJoin(projects, eq(projects.id, pm.projectId))
              .innerJoin(
                tm,
                and(eq(tm.teamId, projects.teamId), eq(tm.userId, pm.userId)),
              )
              .where(
                and(
                  eq(pm.projectId, pid),
                  inArray(pm.userId, ids),
                  eq(users.accountType, "team"),
                  eq(users.status, "active"),
                ),
              )
          : [];
        if (members.length !== ids.length)
          fail(
            400,
            "INVALID_ASSIGNEE",
            "프로젝트의 개발팀 참여자만 배정할 수 있습니다.",
          );
        const previous = await tx
          .select({ id: a.userId })
          .from(a)
          .where(eq(a.requestId, rid));
        if (
          previous
            .map((x) => x.id)
            .sort()
            .join(",") !== [...ids].sort().join(",")
        ) {
          changed = true;
          await tx.delete(a).where(eq(a.requestId, rid));
          if (ids.length)
            await tx
              .insert(a)
              .values(ids.map((userId) => ({ requestId: rid, userId })));
          await tx.insert(e).values({
            requestId: rid,
            kind: "assignment",
            actorId: u.id,
            createdAt: sql`clock_timestamp()`,
            body: members.length
              ? `담당자: ${members.map((x) => x.name).join(", ")}`
              : "담당자 배정이 해제되었습니다.",
          });
        }
      }
      if (changed)
        await tx.update(r).set({ updatedAt: new Date() }).where(eq(r.id, rid));
      return {
        request: await this.output(tx, await this.record(tx, pid, rid)),
      };
    });
  }
  async comment(u: User, pid: string, rid: string, b: Record<string, unknown>) {
    const body = bounded(b?.body, 5000);
    return this.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      await this.record(tx, pid, rid, true);
      const [event] = await tx
        .insert(e)
        .values({
          requestId: rid,
          kind: "comment",
          actorId: u.id,
          createdAt: sql`clock_timestamp()`,
          body,
        })
        .returning();
      await tx.update(r).set({ updatedAt: new Date() }).where(eq(r.id, rid));
      return { event: { ...event, actorName: u.displayName } };
    });
  }
  async upload(u: User, pid: string, rid: string, files: Upload[]) {
    if (!files?.length || files.length > 5)
      fail(400, "INVALID_FILE", "파일을 1~5개 선택해주세요.");
    const names = files.map(validateUpload);
    return this.db.transaction(async (tx) => {
      const access = await this.access(tx, u, pid);
      const request = await this.record(tx, pid, rid, true);
      if (request.createdBy !== u.id && !access.canManage)
        fail(403, "FORBIDDEN", "작성자와 개발팀만 첨부할 수 있습니다.");
      const existing = await tx
        .select({ size: f.size })
        .from(f)
        .where(eq(f.requestId, rid));
      if (
        existing.length + files.length > 5 ||
        [...existing, ...files].reduce((s, x) => s + x.size, 0) >
          20 * 1024 * 1024
      )
        fail(400, "FILE_LIMIT", "첨부는 최대 5개, 합계 20MB까지 가능합니다.");
      await tx.insert(f).values(
        files.map((x, i) => ({
          requestId: rid,
          name: names[i],
          mimeType: x.mimetype,
          size: x.size,
          content: x.buffer,
          createdBy: u.id,
        })),
      );
      await tx.insert(e).values({
        requestId: rid,
        kind: "attachment",
        actorId: u.id,
        createdAt: sql`clock_timestamp()`,
        body: `파일 ${files.length}개가 첨부되었습니다.`,
      });
      await tx.update(r).set({ updatedAt: new Date() }).where(eq(r.id, rid));
      return { attachments: await this.files(tx, pid, rid) };
    });
  }
  async download(u: User, pid: string, rid: string, fid: string) {
    return this.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      await this.record(tx, pid, rid);
      const [file] = await tx
        .select()
        .from(f)
        .where(and(eq(f.id, uuid(fid)), eq(f.requestId, rid)));
      if (!file) fail(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
      return file;
    });
  }
}
