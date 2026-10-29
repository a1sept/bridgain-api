import { Injectable } from "@nestjs/common";
import {
  and,
  eq,
  inArray,
  sql,
  desc,
  asc,
  or,
  lt,
  gt,
  type SQL,
} from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { activityEvents as events } from "../db/schema/activity.js";
import {
  projects,
  projectMemberships,
  teamMemberships,
} from "../db/schema/workspace.js";
import { projectRequests } from "../db/schema/requests.js";
import {
  projectMeetings,
  meetingRequests,
  taskRequests,
  taskAssignees,
} from "../db/schema/project-work.js";
import { users } from "../db/schema/auth.js";
import { RequestsService } from "./requests.service.js";
import { fail } from "../auth/security.js";
import { uuid } from "./workspace.service.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function activityCursor(value: unknown) {
  if (!value) return null;
  try {
    const c = JSON.parse(Buffer.from(String(value), "base64url").toString());
    if (typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)))
      throw Error();
    return { at: new Date(c.at), id: uuid(c.id) };
  } catch {
    fail(400, "INVALID_CURSOR", "기록을 새로 불러와주세요.");
  }
}
@Injectable()
export class ActivityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private async scope(tx: Tx, u: User) {
    if (u.accountType !== "team")
      fail(403, "FORBIDDEN", "개발팀만 활동 기록을 조회할 수 있습니다.");
    const rows = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .where(eq(projectMemberships.userId, u.id));
    const scope = [];
    for (const p of rows) {
      const a = await this.requests.access(tx, u, p.id);
      if (a.isDeveloper && a.permissions.includes("activity.read"))
        scope.push({ ...p, permissions: a.permissions });
    }
    return scope;
  }
  private visibility(scope: { id: string; permissions: string[] }[]) {
    return or(
      ...scope.map((p) =>
        and(
          eq(events.projectId, p.id),
          inArray(events.category, [
            ...(p.permissions.includes("requests.read") ? ["request"] : []),
            ...(p.permissions.includes("meetings.read") ? ["meeting"] : []),
            ...(p.permissions.includes("tasks.read")
              ? ["task", "deployment"]
              : []),
          ]),
        ),
      ),
    );
  }
  private redact(event: typeof events.$inferSelect, permissions: string[]) {
    return {
      ...event,
      requests: permissions.includes("requests.read") ? event.requests : [],
      requestIds: permissions.includes("requests.read") ? event.requestIds : [],
      meetingId: permissions.includes("meetings.read") ? event.meetingId : null,
    };
  }
  async options(u: User, q: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      const scope = await this.scope(tx, u);
      const ids = this.projectIds(
        q,
        scope.map((p) => p.id),
      );
      const readable = scope
        .filter(
          (p) => ids.includes(p.id) && p.permissions.includes("requests.read"),
        )
        .map((p) => p.id);
      const requests = readable.length
        ? await tx
            .select({
              id: projectRequests.id,
              title: projectRequests.title,
              origin: projectRequests.origin,
              projectId: projectRequests.projectId,
            })
            .from(projectRequests)
            .where(inArray(projectRequests.projectId, readable))
        : [];
      const members = ids.length
        ? await tx
            .select({
              id: users.id,
              displayName: users.displayName,
              projectId: projects.id,
            })
            .from(projectMemberships)
            .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
            .innerJoin(users, eq(users.id, projectMemberships.userId))
            .innerJoin(
              teamMemberships,
              and(
                eq(teamMemberships.teamId, projects.teamId),
                eq(teamMemberships.userId, users.id),
              ),
            )
            .where(
              and(
                inArray(projects.id, ids),
                eq(users.accountType, "team"),
                sql`${projectMemberships.accessRole} <> 'client'`,
              ),
            )
        : [];
      return {
        projects: scope.map(({ id, name }) => ({ id, name })),
        requests,
        members,
      };
    });
  }
  private projectIds(q: Record<string, unknown>, available: string[]) {
    const selected =
      typeof q.projectIds === "string" && q.projectIds
        ? q.projectIds.split(",").map(uuid)
        : [];
    if (selected.length > 50)
      fail(400, "VALIDATION_ERROR", "프로젝트는 최대 50개입니다.");
    return selected.length
      ? selected.filter((id) => available.includes(id))
      : available;
  }
  async list(u: User, q: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      const all = await this.scope(tx, u);
      const ids = this.projectIds(
        q,
        all.map((p) => p.id),
      );
      const scope = all.filter((p) => ids.includes(p.id));
      if (!scope.length) return { events: [], nextCursor: null };
      const predicates: SQL[] = [this.visibility(scope)!];
      if (q.requestId) {
        const id = uuid(q.requestId);
        predicates.push(sql`${id}::uuid = ANY(${events.requestIds})`);
        predicates.push(
          inArray(
            events.projectId,
            scope
              .filter((p) => p.permissions.includes("requests.read"))
              .map((p) => p.id),
          ),
        );
      }
      if (q.assigneeId) {
        const id = uuid(q.assigneeId);
        predicates.push(
          inArray(
            events.projectId,
            scope
              .filter((p) => p.permissions.includes("tasks.read"))
              .map((p) => p.id),
          ),
        );
        predicates.push(
          sql`(${id}::uuid = ANY(${events.assigneeIds}) OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=${events.taskId} AND ta.user_id=${id}::uuid) OR (${events.category} IN ('request','meeting') AND EXISTS (SELECT 1 FROM task_requests tr JOIN task_assignees ta ON ta.task_id=tr.task_id WHERE ta.user_id=${id}::uuid AND tr.request_id = ANY(${events.requestIds}))))`,
        );
      }
      if (q.category) {
        if (
          !["request", "meeting", "task", "deployment"].includes(
            String(q.category),
          )
        )
          fail(400, "VALIDATION_ERROR", "활동 유형을 확인해주세요.");
        predicates.push(eq(events.category, String(q.category)));
      }
      const ascending = q.order === "asc";
      const cursor = activityCursor(q.cursor);
      if (cursor)
        predicates.push(
          or(
            (ascending ? gt : lt)(events.occurredAt, cursor.at),
            and(
              eq(events.occurredAt, cursor.at),
              (ascending ? gt : lt)(events.id, cursor.id),
            ),
          )!,
        );
      const limit = 50;
      const rows = await tx
        .select()
        .from(events)
        .where(and(...predicates))
        .orderBy(
          (ascending ? asc : desc)(events.occurredAt),
          (ascending ? asc : desc)(events.id),
        )
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        events: page.map((e) => ({
          ...this.redact(
            e,
            scope.find((p) => p.id === e.projectId)!.permissions,
          ),
          projectName: scope.find((p) => p.id === e.projectId)!.name,
        })),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  at: last.occurredAt.toISOString(),
                  id: last.id,
                }),
              ).toString("base64url")
            : null,
      };
    });
  }
  async detail(u: User, id: string) {
    return this.database.db.transaction(async (tx) => {
      const scope = await this.scope(tx, u);
      if (!scope.length) fail(404, "NOT_FOUND", "기록을 찾을 수 없습니다.");
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, uuid(id)), this.visibility(scope)));
      if (!event) fail(404, "NOT_FOUND", "기록을 찾을 수 없습니다.");
      const p = scope.find((p) => p.id === event.projectId)!;
      let meeting = null;
      let linked = event.requests;
      if (event.meetingId && p.permissions.includes("meetings.read")) {
        const [m] = await tx
          .select()
          .from(projectMeetings)
          .where(
            and(
              eq(projectMeetings.id, event.meetingId),
              eq(projectMeetings.projectId, event.projectId),
            ),
          );
        if (m)
          meeting = {
            id: m.id,
            title: m.title,
            scheduledAt: m.scheduledAt,
            durationMinutes: m.durationMinutes,
            location: m.location,
            status: m.status,
            startedAt: m.startedAt,
            endedAt: m.endedAt,
            notes: m.notes,
          };
        if (p.permissions.includes("requests.read")) {
          const current = await tx
            .select({
              id: projectRequests.id,
              title: projectRequests.title,
              origin: projectRequests.origin,
            })
            .from(meetingRequests)
            .innerJoin(
              projectRequests,
              eq(projectRequests.id, meetingRequests.requestId),
            )
            .where(eq(meetingRequests.meetingId, event.meetingId));
          linked = [
            ...new Map(
              [...current, ...event.requests].map((r) => [r.id, r]),
            ).values(),
          ];
        }
      }
      return {
        event: { ...this.redact(event, p.permissions), projectName: p.name },
        meeting,
        requests: p.permissions.includes("requests.read") ? linked : [],
      };
    });
  }
}
