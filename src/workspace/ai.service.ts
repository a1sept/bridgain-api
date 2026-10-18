import { projectTasks } from "../db/schema/project-work.js";
import { Injectable } from "@nestjs/common";
import { and, eq, asc, desc, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  aiSessions as sessions,
  aiSessionRequests as links,
  aiMessages as messages,
  aiDrafts as drafts,
} from "../db/schema/ai.js";
import { projectRequests, requestEvents } from "../db/schema/requests.js";
import { RequestsService } from "./requests.service.js";
import { ProjectWorkService, choice, ids } from "./project-work.service.js";
import { uuid, bounded } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; accountType: string; displayName: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function draftPayload(
  kind: string,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "VALIDATION_ERROR", "초안 내용을 확인해주세요.");
  const b = value as Record<string, unknown>;
  const permitted: Record<string, string[]> = {
    note: ["content"],
    task: ["title", "description", "priority", "requestIds"],
    meeting: ["title", "notes", "scheduledAt", "durationMinutes", "requests"],
    result: [
      "taskId",
      "expectedVersion",
      "changeSummary",
      "resultSummary",
      "dbChanges",
      "apiChanges",
      "frontendChanges",
      "verification",
    ],
    document: [
      "documentId",
      "title",
      "category",
      "content",
      "url",
      "changeSummary",
      "taskId",
    ],
  };
  if (!permitted[kind])
    fail(400, "VALIDATION_ERROR", "초안 종류를 확인해주세요.");
  if (Object.keys(b).some((k) => !permitted[kind].includes(k)))
    fail(400, "INVALID_DRAFT", "초안에 허용되지 않은 변경이 있습니다.");
  if (JSON.stringify(b).length > 50000)
    fail(400, "VALIDATION_ERROR", "초안은 50,000자 이하여야 합니다.");
  if (kind === "note") bounded(b.content, 20000);
  if (kind === "result") {
    uuid(b.taskId);
    uuid(b.expectedVersion);
  }
  if (kind === "document" && b.documentId) uuid(b.documentId);
  return b;
}
@Injectable()
export class AiService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
    private readonly work: ProjectWorkService,
  ) {}
  private async access(tx: Tx, u: User, pid: string) {
    const p = await this.requests.access(tx, u, pid);
    if (!p.isDeveloper)
      fail(403, "FORBIDDEN", "개발자만 AI 세션을 사용할 수 있습니다.");
    // Historical conversations may contain any of these areas. Revoked reads
    // must not remain accessible through saved messages or draft payloads.
    if (
      !["requests.read", "meetings.read", "documents.read", "tasks.read"].every(
        (key) => p.permissions.includes(key),
      )
    )
      fail(
        403,
        "FORBIDDEN",
        "AI 작업 공간에는 요청·회의·문서·업무 조회 권한이 모두 필요합니다.",
      );
  }
  private async owned(tx: Tx, u: User, pid: string, id: string, lock = false) {
    await this.access(tx, u, pid);
    const q = tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, uuid(id)),
          eq(sessions.projectId, uuid(pid)),
          eq(sessions.ownerId, u.id),
        ),
      );
    const [row] = await (lock ? q.for("update") : q);
    if (!row) fail(404, "NOT_FOUND", "AI 세션을 찾을 수 없습니다.");
    return row;
  }
  private async link(tx: Tx, sid: string, pid: string, requestIds: unknown) {
    for (const rid of ids(requestIds)) {
      const [r] = await tx
        .select()
        .from(projectRequests)
        .where(
          and(eq(projectRequests.id, rid), eq(projectRequests.projectId, pid)),
        );
      if (!r)
        fail(
          400,
          "INVALID_REQUEST",
          "같은 프로젝트의 요청만 연결할 수 있습니다.",
        );
      await tx
        .insert(links)
        .values({ sessionId: sid, requestId: rid })
        .onConflictDoNothing();
    }
  }
  async list(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      return {
        sessions: await tx
          .select()
          .from(sessions)
          .where(and(eq(sessions.projectId, pid), eq(sessions.ownerId, u.id)))
          .orderBy(desc(sessions.updatedAt))
          .limit(100),
      };
    });
  }
  async create(u: User, pid: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid);
      const [row] = await tx
        .insert(sessions)
        .values({
          projectId: uuid(pid),
          ownerId: u.id,
          provider: choice(b?.provider, ["codex", "claude"]),
          title: bounded(b?.title, 160),
        })
        .returning();
      await this.link(tx, row.id, pid, b.requestIds ?? []);
      return { session: row };
    });
  }
  async detail(u: User, pid: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      const session = await this.owned(tx, u, pid, id);
      return {
        session,
        requests: await tx
          .select({
            id: projectRequests.id,
            title: projectRequests.title,
            description: projectRequests.description,
            status: projectRequests.status,
          })
          .from(links)
          .innerJoin(projectRequests, eq(projectRequests.id, links.requestId))
          .where(eq(links.sessionId, id)),
        messages: await tx
          .select()
          .from(messages)
          .where(eq(messages.sessionId, id))
          .orderBy(asc(messages.createdAt), asc(messages.id)),
        drafts: await tx
          .select()
          .from(drafts)
          .where(eq(drafts.sessionId, id))
          .orderBy(desc(drafts.createdAt)),
      };
    });
  }
  async update(u: User, pid: string, id: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      await this.owned(tx, u, pid, id, true);
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "VALIDATION_ERROR", "세션 내용을 확인해주세요.");
      if (b.requestIds !== undefined)
        await this.link(tx, id, pid, b.requestIds);
      const values: Record<string, unknown> = {
        updatedAt: sql`clock_timestamp()`,
      };
      if (b.localSessionId !== undefined)
        values.localSessionId = bounded(b.localSessionId, 200);
      if (b.commit !== undefined) values.commit = bounded(b.commit, 80, false);
      await tx.update(sessions).set(values).where(eq(sessions.id, id));
      return { ok: true };
    });
  }
  async message(u: User, pid: string, id: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      await this.owned(tx, u, pid, id, true);
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "VALIDATION_ERROR", "메시지 내용을 확인해주세요.");
      const clientId = uuid(b.clientId);
      const [existing] = await tx
        .select()
        .from(messages)
        .where(
          and(eq(messages.sessionId, id), eq(messages.clientId, clientId)),
        );
      if (existing) return { message: existing };
      const context =
        b.context && typeof b.context === "object" && !Array.isArray(b.context)
          ? (b.context as Record<string, unknown>)
          : {};
      const requestIds = ids(context.requestIds ?? []);
      for (const rid of requestIds) {
        const [linked] = await tx
          .select()
          .from(links)
          .where(and(eq(links.sessionId, id), eq(links.requestId, rid)));
        if (!linked)
          fail(
            400,
            "INVALID_REQUEST",
            "세션에 연결된 요청만 조사 기준에 기록할 수 있습니다.",
          );
      }
      const [message] = await tx
        .insert(messages)
        .values({
          sessionId: id,
          role: choice(b.role, ["user", "assistant", "system"]),
          body: bounded(b.body, 50000),
          clientId,
          context: {
            commit: bounded(context.commit ?? "", 80, false),
            requestIds,
          },
          createdAt: sql`clock_timestamp()`,
        })
        .returning();
      await tx
        .update(sessions)
        .set({ updatedAt: sql`clock_timestamp()` })
        .where(eq(sessions.id, id));
      return { message };
    });
  }
  async tool(u: User, pid: string, id: string, name: unknown, args: unknown) {
    await this.database.db.transaction((tx) => this.owned(tx, u, pid, id));
    if (!args || typeof args !== "object" || Array.isArray(args))
      fail(400, "VALIDATION_ERROR", "도구 입력을 확인해주세요.");
    const b = args as Record<string, unknown>;
    switch (name) {
      case "get_requests":
        return this.requests.list(u, pid);
      case "get_request":
        return this.requests.detail(u, pid, uuid(b.requestId));
      case "get_tasks":
        return this.work.listTasks(u, pid);
      case "get_documents": {
        const d = await this.work.listDocuments(u, pid);
        return {
          documents: d.documents.map(({ versions, ...document }) => document),
        };
      }
      case "save_draft": {
        const kind = choice(b.kind, [
          "note",
          "task",
          "meeting",
          "result",
          "document",
        ]);
        const payload = draftPayload(kind, b.payload);
        return this.database.db.transaction(async (tx) => {
          await this.owned(tx, u, pid, id, true);
          const [draft] = await tx
            .insert(drafts)
            .values({
              sessionId: id,
              kind,
              title: bounded(b.title, 160),
              payload,
            })
            .returning();
          return { draft };
        });
      }
      default:
        fail(400, "UNKNOWN_TOOL", "지원하지 않는 AI 도구입니다.");
    }
  }
  async apply(u: User, pid: string, id: string, did: string) {
    // Serialize approval retries with a session-level advisory lock; downstream services retain their own membership checks.
    return this.database.db.transaction(async (tx) => {
      // Serialize role revocation and applying an AI draft with project writes.
      await this.requests.access(tx, u, pid, true);
      await this.owned(tx, u, pid, id);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`,
      );
      const [draft] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, uuid(did)), eq(drafts.sessionId, id)))
        .for("update");
      if (!draft) fail(404, "NOT_FOUND", "초안을 찾을 수 없습니다.");
      if (draft.appliedAt)
        return { alreadyApplied: true, targetId: draft.targetId };
      const b = draftPayload(draft.kind, draft.payload);
      let targetId: string | null = null;
      switch (draft.kind) {
        case "note":
          break;
        case "task": {
          // AI can propose scope, never authorize execution.
          const access = await this.requests.access(tx, u, pid);
          if (!access.permissions.includes("requests.create"))
            fail(403, "FORBIDDEN", "개발 요청 작성 권한이 필요합니다.");
          const [request] = await tx
            .insert(projectRequests)
            .values({
              projectId: pid,
              origin: "development",
              title: bounded(b.title, 160),
              description: bounded(b.description ?? "", 10000, false),
              type: "other",
              priority: "normal",
              createdBy: u.id,
            })
            .returning();
          await tx.insert(requestEvents).values({
            requestId: request.id,
            kind: "created",
            status: "received",
            body: "AI 초안을 개발 요청으로 등록했습니다. 업무화에는 승인이 필요합니다.",
            actorId: u.id,
          });
          targetId = request.id;
          break;
        }
        case "meeting":
          targetId = (
            await this.work.saveMeeting(
              u,
              pid,
              { ...b, decisionStatus: "draft", status: "scheduled" },
              undefined,
              tx,
            )
          ).meeting.id;
          break;
        case "result": {
          const { taskId, changeSummary, ...result } = b;
          const [task] = await tx
            .select()
            .from(projectTasks)
            .where(
              and(
                eq(projectTasks.id, uuid(taskId)),
                eq(projectTasks.projectId, pid),
              ),
            );
          if (!task) return fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
          if (["done", "released"].includes(task.status)) {
            await this.work.appendResult(
              u,
              pid,
              task.id,
              { ...result, changeSummary: changeSummary || draft.title },
              tx,
            );
            targetId = task.id;
          } else {
            targetId = (
              await this.work.saveTask(
                u,
                pid,
                result,
                uuid(taskId),
                undefined,
                tx,
              )
            ).task.id;
          }
          break;
        }
        case "document": {
          const { documentId, ...body } = b;
          targetId = (
            await this.work.saveDocument(
              u,
              pid,
              body,
              documentId ? uuid(documentId) : undefined,
              tx,
            )
          ).document.id;
          break;
        }
      }
      await tx
        .update(drafts)
        .set({ targetId, appliedAt: sql`clock_timestamp()` })
        .where(eq(drafts.id, did));
      return { targetId };
    });
  }
}
