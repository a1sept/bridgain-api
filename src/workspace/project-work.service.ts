import { Injectable } from "@nestjs/common";
import { and, eq, ne, inArray, desc, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { users } from "../db/schema/auth.js";
import {
  projects,
  projectMemberships as pm,
  teamMemberships as tm,
} from "../db/schema/workspace.js";
import { projectRequests, requestEvents } from "../db/schema/requests.js";
import {
  projectTasks as tasks,
  taskAssignees,
  taskRequests,
  projectMeetings as meetings,
  projectDocuments as documents,
  projectActivity as activity,
} from "../db/schema/project-work.js";
import { RequestsService } from "./requests.service.js";
import { bounded, uuid } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function choice(value: unknown, values: string[]) {
  if (typeof value !== "string" || !values.includes(value))
    fail(400, "VALIDATION_ERROR", "선택 값을 확인해주세요.");
  return value as string;
}
export function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50)
    fail(400, "VALIDATION_ERROR", "연결 항목은 최대 50개입니다.");
  return [...new Set((value as unknown[]).map((v) => uuid(v).toLowerCase()))];
}
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
export function documentUrl(value: unknown): string | null {
  if (value === null || value === "") return null;
  const v = bounded(value, 2000);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    fail(400, "VALIDATION_ERROR", "올바른 링크를 입력해주세요.");
  }
  if (
    !["http:", "https:"].includes(url!.protocol) ||
    url!.username ||
    url!.password
  )
    fail(400, "VALIDATION_ERROR", "HTTP 또는 HTTPS 링크를 입력해주세요.");
  return v;
}
export function meetingDate(value: unknown): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail(400, "VALIDATION_ERROR", "시간대가 포함된 회의 일시를 입력해주세요.");
  dueDate((value as string).slice(0, 10));
  return new Date(value as string);
}
@Injectable()
export class ProjectWorkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private async access(tx: Tx, u: User, pid: string, lock = false) {
    const access = await this.requests.access(tx, u, pid, lock);
    if (!access.canManage)
      fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
  }
  private async event(
    tx: Tx,
    u: User,
    pid: string,
    id: string,
    kind: string,
    title: string,
  ) {
    await tx
      .insert(activity)
      .values({
        projectId: pid,
        entityId: id,
        kind,
        body: title,
        actorId: u.id,
        createdAt: sql`clock_timestamp()`,
      });
  }
  private async links(
    tx: Tx,
    pid: string,
    assigneeIds: string[],
    requestIds: string[],
  ) {
    if (assigneeIds.length) {
      const members = await tx
        .select({ id: users.id })
        .from(pm)
        .innerJoin(projects, eq(projects.id, pm.projectId))
        .innerJoin(
          tm,
          and(eq(tm.teamId, projects.teamId), eq(tm.userId, pm.userId)),
        )
        .innerJoin(users, eq(users.id, pm.userId))
        .where(
          and(
            eq(pm.projectId, pid),
            ne(pm.accessRole, "client"),
            eq(users.accountType, "team"),
            eq(users.status, "active"),
            inArray(users.id, assigneeIds),
          ),
        );
      if (members.length !== assigneeIds.length)
        fail(
          400,
          "INVALID_ASSIGNEE",
          "프로젝트에 참여한 개발팀만 배정할 수 있습니다.",
        );
    }
    if (requestIds.length) {
      const found = await tx
        .select({ id: projectRequests.id })
        .from(projectRequests)
        .where(
          and(
            eq(projectRequests.projectId, pid),
            inArray(projectRequests.id, requestIds),
          ),
        );
      if (found.length !== requestIds.length)
        fail(
          400,
          "INVALID_REQUEST",
          "이 프로젝트의 요청만 연결할 수 있습니다.",
        );
    }
  }
  private async taskOutput(tx: Tx, row: typeof tasks.$inferSelect) {
    const assignees = await tx
      .select({ userId: users.id, displayName: users.displayName })
      .from(taskAssignees)
      .innerJoin(users, eq(users.id, taskAssignees.userId))
      .where(eq(taskAssignees.taskId, row.id));
    const requests = await tx
      .select({ id: projectRequests.id, title: projectRequests.title })
      .from(taskRequests)
      .innerJoin(
        projectRequests,
        eq(projectRequests.id, taskRequests.requestId),
      )
      .where(eq(taskRequests.taskId, row.id));
    return {
      ...row,
      assignees,
      requests,
      assigneeIds: assignees.map((x) => x.userId),
      requestIds: requests.map((x) => x.id),
    };
  }
  async listTasks(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const rows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, pid))
        .orderBy(desc(tasks.createdAt));
      return {
        tasks: await Promise.all(rows.map((r) => this.taskOutput(tx, r))),
      };
    });
  }
  async saveTask(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, true);
      let old: typeof tasks.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      }
      const current = old ? await this.taskOutput(tx, old) : undefined;
      const title = bounded(b?.title ?? old?.title, 160),
        description = bounded(
          b?.description ?? old?.description ?? "",
          10000,
          false,
        ),
        status = choice(b?.status ?? old?.status ?? "todo", [
          "todo",
          "in_progress",
          "done",
        ]),
        priority = choice(b?.priority ?? old?.priority ?? "normal", [
          "urgent",
          "high",
          "normal",
          "low",
        ]);
      const due = dueDate(
          b?.dueDate === undefined ? (old?.dueDate ?? null) : b.dueDate,
        ),
        assigneeIds = ids(b?.assigneeIds ?? current?.assigneeIds ?? []),
        requestIds = ids(b?.requestIds ?? current?.requestIds ?? []);
      await this.links(tx, pid, assigneeIds, requestIds);
      const values = { title, description, status, priority, dueDate: due };
      const [row] = old
        ? await tx
            .update(tasks)
            .set({ ...values, updatedAt: sql`clock_timestamp()` })
            .where(eq(tasks.id, old.id))
            .returning()
        : await tx
            .insert(tasks)
            .values({ ...values, projectId: pid, createdBy: u.id })
            .returning();
      await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, row.id));
      await tx.delete(taskRequests).where(eq(taskRequests.taskId, row.id));
      if (assigneeIds.length)
        await tx
          .insert(taskAssignees)
          .values(assigneeIds.map((userId) => ({ taskId: row.id, userId })));
      if (requestIds.length)
        await tx
          .insert(taskRequests)
          .values(
            requestIds.map((requestId) => ({ taskId: row.id, requestId })),
          );
      await this.event(
        tx,
        u,
        pid,
        row.id,
        old ? "task_updated" : "task_created",
        title,
      );
      return { task: await this.taskOutput(tx, row) };
    });
  }
  async listMeetings(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      return {
        meetings: await tx
          .select()
          .from(meetings)
          .where(eq(meetings.projectId, pid))
          .orderBy(desc(meetings.scheduledAt)),
      };
    });
  }
  async saveMeeting(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, true);
      let old: typeof meetings.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(meetings)
          .where(and(eq(meetings.id, uuid(id)), eq(meetings.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "회의를 찾을 수 없습니다.");
      }
      const duration = b?.durationMinutes ?? old?.durationMinutes ?? 60;
      if (
        typeof duration !== "number" ||
        !Number.isInteger(duration) ||
        duration < 15 ||
        duration > 480
      )
        fail(400, "VALIDATION_ERROR", "회의 시간은 15~480분입니다.");
      const requestId =
        b?.requestId === undefined
          ? (old?.requestId ?? null)
          : b.requestId === null
            ? null
            : uuid(b.requestId);
      await this.links(tx, pid, [], requestId ? [requestId] : []);
      const values = {
        title: bounded(b?.title ?? old?.title, 160),
        scheduledAt: meetingDate(
          b?.scheduledAt ?? old?.scheduledAt.toISOString(),
        ),
        durationMinutes: duration as number,
        location: bounded(b?.location ?? old?.location ?? "", 1000, false),
        notes: bounded(b?.notes ?? old?.notes ?? "", 20000, false),
        status: choice(b?.status ?? old?.status ?? "scheduled", [
          "scheduled",
          "completed",
        ]),
        requestId,
      };
      const [row] = old
        ? await tx
            .update(meetings)
            .set({ ...values, updatedAt: sql`clock_timestamp()` })
            .where(eq(meetings.id, old.id))
            .returning()
        : await tx
            .insert(meetings)
            .values({ ...values, projectId: pid, createdBy: u.id })
            .returning();
      await this.event(
        tx,
        u,
        pid,
        row.id,
        old ? "meeting_updated" : "meeting_created",
        row.title,
      );
      return { meeting: row };
    });
  }
  async listDocuments(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const rows = await tx
        .select({ document: documents, creatorName: users.displayName })
        .from(documents)
        .innerJoin(users, eq(users.id, documents.createdBy))
        .where(eq(documents.projectId, pid))
        .orderBy(desc(documents.updatedAt));
      return {
        documents: rows.map((x) => ({
          ...x.document,
          creatorName: x.creatorName,
        })),
      };
    });
  }
  async saveDocument(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, true);
      let old: typeof documents.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, uuid(id)), eq(documents.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "문서를 찾을 수 없습니다.");
      }
      const values = {
        title: bounded(b?.title ?? old?.title, 160),
        category: choice(b?.category ?? old?.category ?? "other", [
          "plan",
          "design",
          "api",
          "meeting",
          "other",
        ]),
        content: bounded(b?.content ?? old?.content ?? "", 50000, false),
        url: documentUrl(b?.url === undefined ? (old?.url ?? null) : b.url),
      };
      const [row] = old
        ? await tx
            .update(documents)
            .set({ ...values, updatedAt: sql`clock_timestamp()` })
            .where(eq(documents.id, old.id))
            .returning()
        : await tx
            .insert(documents)
            .values({ ...values, projectId: pid, createdBy: u.id })
            .returning();
      await this.event(
        tx,
        u,
        pid,
        row.id,
        old ? "document_updated" : "document_created",
        row.title,
      );
      const [creator] = await tx
        .select({ name: users.displayName })
        .from(users)
        .where(eq(users.id, row.createdBy));
      return { document: { ...row, creatorName: creator.name } };
    });
  }
  async listActivity(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const events = await tx
        .select({
          id: activity.id,
          entityId: activity.entityId,
          kind: activity.kind,
          body: activity.body,
          createdAt: activity.createdAt,
          actorName: users.displayName,
        })
        .from(activity)
        .innerJoin(users, eq(users.id, activity.actorId))
        .where(eq(activity.projectId, pid))
        .orderBy(desc(activity.createdAt))
        .limit(100);
      const requests = await tx
        .select({
          id: requestEvents.id,
          entityId: requestEvents.requestId,
          kind: requestEvents.kind,
          body: requestEvents.body,
          createdAt: requestEvents.createdAt,
          actorName: users.displayName,
          title: projectRequests.title,
          status: requestEvents.status,
        })
        .from(requestEvents)
        .innerJoin(
          projectRequests,
          eq(projectRequests.id, requestEvents.requestId),
        )
        .innerJoin(users, eq(users.id, requestEvents.actorId))
        .where(eq(projectRequests.projectId, pid))
        .orderBy(desc(requestEvents.createdAt))
        .limit(100);
      return {
        events: [
          ...events,
          ...requests.map((e) => ({
            ...e,
            kind: `request_${e.kind}`,
            body: e.body || e.title,
          })),
        ]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 100),
      };
    });
  }
}
