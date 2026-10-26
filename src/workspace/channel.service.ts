import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { RequestsService } from "./requests.service.js";
import { fail } from "../auth/security.js";
import { uuid, bounded } from "./workspace.service.js";
import { channelMessages } from "../db/schema/channel.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function channelVisibility(developer: boolean, permissions: string[]) {
  if (!developer)
    fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
  return {
    task: permissions.includes("tasks.read"),
    meeting: permissions.includes("meetings.read"),
    approval:
      permissions.includes("tasks.read") &&
      permissions.includes("meetings.read") &&
      permissions.includes("requests.read"),
  };
}
@Injectable()
export class ChannelService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private async context(tx: Tx, u: User, pid: string) {
    const access = await this.requests.access(tx, u, uuid(pid), true);
    return channelVisibility(access.isDeveloper, access.permissions);
  }
  private feed(
    pid: string,
    visibility: { task: boolean; meeting: boolean; approval: boolean },
  ) {
    return sql`WITH feed AS (
 SELECT 'message:'||m.id AS key, 'message'::text AS kind, m.body, u.display_name AS "actorName", m.created_at AS "createdAt", m.parent_key AS "parentKey", m.target_kind AS "targetKind", m.target_id AS "targetId", COALESCE(t.title,mt.title,'프로젝트 대화') AS title
 FROM channel_messages m JOIN users u ON u.id=m.actor_id LEFT JOIN project_tasks t ON t.id=m.target_id AND t.project_id=m.project_id LEFT JOIN project_meetings mt ON mt.id=m.target_id AND mt.project_id=m.project_id
 WHERE m.project_id=${pid} AND (m.parent_key IS NULL OR m.parent_key NOT LIKE 'approval:%' OR ${visibility.approval}) AND (m.target_kind IS NULL OR (m.target_kind='task' AND ${visibility.task} AND t.id IS NOT NULL) OR (m.target_kind='meeting' AND ${visibility.meeting} AND mt.id IS NOT NULL))
 UNION ALL
 SELECT 'work:'||e.id,e.action,e.note,u.display_name,e.created_at,NULL,'task',t.id,t.title FROM task_work_events e JOIN project_tasks t ON t.id=e.task_id JOIN users u ON u.id=e.actor_id WHERE t.project_id=${pid} AND ${visibility.task}
 UNION ALL
 SELECT 'approval:'||a.id,'approval_'||a.status,''::text,u.display_name,a.updated_at,NULL,CASE WHEN a.meeting_id IS NULL THEN NULL ELSE 'meeting' END,a.meeting_id,a.title FROM task_approvals a JOIN users u ON u.id=a.requested_by WHERE a.project_id=${pid} AND ${visibility.approval}
 UNION ALL
 SELECT 'activity:'||a.id,a.kind,''::text,u.display_name,a.created_at,NULL,'meeting',a.entity_id,a.body FROM project_activity a JOIN users u ON u.id=a.actor_id WHERE a.project_id=${pid} AND a.kind='meeting_completed' AND ${visibility.meeting}
 )`;
  }
  async list(
    u: User,
    pid: string,
    parent?: string,
    taskId?: string,
    before?: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const visibility = await this.context(tx, u, pid);
      const feed = this.feed(pid, visibility);
      if (parent) {
        const root = await tx.execute(
          sql`${feed} SELECT key FROM feed WHERE key=${parent} AND "parentKey" IS NULL`,
        );
        if (!root.rows.length)
          fail(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
      }
      if (taskId) uuid(taskId);
      let cursor: string | null = null;
      let cursorKey = "";
      if (before) {
        try {
          const parsed = JSON.parse(before);
          cursor = bounded(parsed.at, 50);
          cursorKey = bounded(parsed.key, 100);
          if (!Number.isFinite(new Date(cursor).getTime())) throw Error();
        } catch {
          fail(400, "INVALID_CURSOR", "잘못된 조회 시점입니다.");
        }
      }
      const result = await tx.execute(
        sql`${feed} SELECT f.*, f."createdAt"::text AS "cursorAt", (SELECT count(*)::int FROM feed replies WHERE replies."parentKey"=f.key) AS "replyCount" FROM feed f WHERE ${parent ? sql`f."parentKey"=${parent}` : sql`f."parentKey" IS NULL`} ${taskId ? sql`AND f."targetKind"='task' AND f."targetId"=${taskId}` : sql``} ${cursor ? sql`AND (f."createdAt",f.key) < (${cursor}::timestamptz,${cursorKey})` : sql``} ORDER BY f."createdAt" DESC,f.key DESC LIMIT 101`,
      );
      return {
        items: result.rows.slice(0, 100).reverse(),
        hasMore: result.rows.length > 100,
      };
    });
  }
  async post(u: User, pid: string, b: Record<string, unknown>) {
    const body = bounded(b?.body, 5000);
    return this.database.db.transaction(async (tx) => {
      const visibility = await this.context(tx, u, pid);
      let targetKind: string | null = null,
        targetId: string | null = null,
        parentKey: string | null = null;
      if (b.parentKey) {
        parentKey = bounded(b.parentKey, 100);
        const roots = await tx.execute(
          sql`${this.feed(pid, visibility)} SELECT * FROM feed WHERE key=${parentKey} AND "parentKey" IS NULL`,
        );
        const root = roots.rows[0];
        if (!root) fail(404, "NOT_FOUND", "대화를 찾을 수 없습니다.");
        targetKind = root.targetKind as string | null;
        targetId = root.targetId as string | null;
        // Approval threads retain the same restrictions as their parent.
        if (parentKey.startsWith("approval:") && !visibility.approval)
          fail(403, "FORBIDDEN", "조회 권한이 없습니다.");
      } else if (b.taskId) {
        targetId = uuid(b.taskId);
        targetKind = "task";
        if (!visibility.task)
          fail(403, "FORBIDDEN", "업무 조회 권한이 없습니다.");
        const task = await tx.execute(
          sql`SELECT id FROM project_tasks WHERE id=${targetId} AND project_id=${pid}`,
        );
        if (!task.rows.length)
          fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      }
      const [message] = await tx
        .insert(channelMessages)
        .values({
          projectId: pid,
          actorId: u.id,
          body,
          parentKey,
          targetKind,
          targetId,
        })
        .returning({ id: channelMessages.id });
      return message;
    });
  }
}
