import { recordTaskActivity } from "./activity-record.js";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  projectTasks as tasks,
  taskAssignees,
  taskDependencies,
  taskWorkReviewers as reviewers,
  taskWorkEvents as events,
  taskDeploymentAttempts as attempts,
} from "../db/schema/project-work.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { fail } from "../auth/security.js";
import { bounded, uuid } from "./workspace.service.js";
import {
  github,
  pullRequestPath,
  checkPullRequest,
  type PullRequest,
} from "./github-pull-request.js";
import { users } from "../db/schema/auth.js";
import { teams, projects } from "../db/schema/workspace.js";
import type { GitEvent } from "./git-events.controller.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
type Task = typeof tasks.$inferSelect;
type User = { id: string; displayName: string; accountType: string };
@Injectable()
export class StagedWorkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private async task(
    tx: Tx,
    u: User,
    pid: string,
    id: string,
    permission = "tasks.read",
  ) {
    const access = await this.requests.access(tx, u, pid, true);
    requireProjectPermission(access, permission);
    if (!access.isDeveloper)
      fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)))
      .for("update");
    if (!task) fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
    if (!task.stageKey)
      fail(409, "STAGED_TASK_REQUIRED", "단계별 업무에서 사용할 수 있습니다.");
    return task;
  }
  private async record(
    tx: Tx,
    task: Task,
    actorId: string,
    action: string,
    note = "",
    headSha = "",
    system = false,
  ) {
    const [recorded]=await tx.insert(events).values({
      taskId: task.id,
      actorId,
      action,
      note,
      headSha,
      revision: task.workRevision,
      createdAt: sql`clock_timestamp()`,
    }).returning();
    const kind=({completed:task.completionMode==="test"?"qa_completed":"task_completed",approved:"task_approved",changes_requested:"task_changes_requested",invalidated:"task_invalidated",deploy_started:"deploy_ready",released:"deploy_completed",deploy_failed:"deploy_failed"} as Record<string,string>)[action] ?? "task_invalidated";
    await recordTaskActivity(tx,task.id,actorId,kind,note,`work:${recorded.id}`,system);

  }
  private async descendants(tx: Tx, task: Task) {
    const found: Task[] = [];
    const visited = new Set<string>([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const edges = await tx
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
        .where(eq(taskDependencies.predecessorId, queue.shift()!));
      for (const edge of edges) {
        if (visited.has(edge.task.id)) continue;
        visited.add(edge.task.id);
        found.push(edge.task);
        queue.push(edge.task.id);
      }
    }
    return found;
  }
  private async reset(tx: Tx, task: Task, actorId: string, note: string) {
    const children = await this.descendants(tx, task);
    if (
      children.some((child) => ["deploying", "released"].includes(child.status))
    )
      fail(
        409,
        "NEW_REQUEST_REQUIRED",
        "이미 배포된 후속 업무가 있습니다. 변경은 새 개발 요청으로 등록해주세요.",
      );
    await tx
      .update(tasks)
      .set({
        status: "in_progress",
        approvedHeadSha: "",
        reviewHeadSha: "",
        workRevision: task.workRevision + 1,
        version: randomUUID(),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(tasks.id, task.id));
    await tx
      .update(taskAssignees)
      .set({ completedAt: null })
      .where(eq(taskAssignees.taskId, task.id));
    await tx
      .update(reviewers)
      .set({ status: "pending", note: "", actedAt: null })
      .where(eq(reviewers.taskId, task.id));
    await this.record(tx, task, actorId, "changes_requested", note);
    for (const child of children) {
      await tx
        .update(tasks)
        .set({
          status: "blocked",
          approvedHeadSha: "",
          reviewHeadSha: "",
          workRevision: child.workRevision + 1,
          version: randomUUID(),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(tasks.id, child.id));
      await tx
        .update(taskAssignees)
        .set({ completedAt: null })
        .where(eq(taskAssignees.taskId, child.id));
      await tx
        .update(reviewers)
        .set({ status: "pending", note: "", actedAt: null })
        .where(eq(reviewers.taskId, child.id));
      await this.record(
        tx,
        child,
        actorId,
        "predecessor_changed",
        "선행 작업이 변경되어 재작업 및 재승인이 필요합니다.",
      );
    }
  }
  private async ancestorTasks(tx: Tx, task: Task) {
    const found: Task[] = [];
    const visited = new Set<string>([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const edges = await tx
        .select({ task: tasks })
        .from(taskDependencies)
        .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
        .where(eq(taskDependencies.taskId, queue.shift()!));
      for (const edge of edges) {
        if (visited.has(edge.task.id)) continue;
        visited.add(edge.task.id);
        found.push(edge.task);
        queue.push(edge.task.id);
      }
    }
    return found;
  }
  private async predecessors(tx: Tx, task: Task) {
    const deps = await this.ancestorTasks(tx, task);
    if (
      deps.some(
        (d) =>
          !["done", "released", "deploy_pending", "deploying"].includes(
            d.status,
          ),
      )
    )
      fail(409, "PREDECESSOR_REQUIRED", "선행 업무 승인이 필요합니다.");
    for (const predecessor of deps) {
      if (
        predecessor.completionMode === "code" &&
        predecessor.stageKey &&
        predecessor.status !== "released"
      ) {
        const { pr } = await this.currentPr(predecessor, true);
        if (
          !predecessor.approvedHeadSha ||
          predecessor.approvedHeadSha !== pr.head.sha
        )
          fail(
            409,
            "PREDECESSOR_CHANGED",
            "선행 업무의 코드가 변경되어 재승인이 필요합니다.",
          );
      }
    }
  }
  private async eligibleReviewer(tx: Tx, u: User, pid: string, userId: string) {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user || user.status !== "active" || user.accountType !== "team")
      fail(
        409,
        "REVIEWER_UNAVAILABLE",
        "지정 승인자의 참여 상태를 확인해주세요.",
      );
    const access = await this.requests.access(
      tx,
      { ...u, id: userId, accountType: user.accountType },
      pid,
    );
    requireProjectPermission(access, "approvals.work");
  }
  private async uniquePr(tx: Tx, task: Task) {
    if (!task.pullRequestUrl)
      fail(400, "INVALID_PR", "GitHub PR 링크를 입력해주세요.");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"bridgain-pr:" + task.pullRequestUrl},0))`,
    );
    const linked = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.pullRequestUrl, task.pullRequestUrl!));
    if (linked.some((t) => t.id !== task.id))
      fail(
        409,
        "DUPLICATE_PR",
        "하나의 PR은 하나의 업무에만 연결할 수 있습니다.",
      );
  }
  private async currentPr(task: Task, allowMerged = false) {
    if (task.liveBranch !== "main")
      fail(409, "MAIN_REQUIRED", "배포 대상 브랜치는 main이어야 합니다.");
    const path = pullRequestPath(
      task.projectId,
      task.repositoryUrl,
      task.pullRequestUrl,
    );
    const pr = await github<PullRequest>(path);
    checkPullRequest(pr, task, allowMerged);
    return { path, pr };
  }
  async history(u: User, pid: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      await this.task(tx, u, pid, id);
      return {
        events: await tx
          .select({
            id: events.id,
            taskId: events.taskId,
            action: events.action,
            note: events.note,
            revision: events.revision,
            headSha: events.headSha,
            createdAt: events.createdAt,
            actorId: events.actorId,
            actorName: users.displayName,
          })
          .from(events)
          .innerJoin(users, eq(users.id, events.actorId))
          .where(eq(events.taskId, id))
          .orderBy(desc(events.createdAt)),
        reviewers: await tx
          .select({
            userId: reviewers.userId,
            status: reviewers.status,
            note: reviewers.note,
            actedAt: reviewers.actedAt,
            displayName: users.displayName,
          })
          .from(reviewers)
          .innerJoin(users, eq(users.id, reviewers.userId))
          .where(eq(reviewers.taskId, id)),
        assignees: await tx
          .select({
            userId: taskAssignees.userId,
            completedAt: taskAssignees.completedAt,
            displayName: users.displayName,
          })
          .from(taskAssignees)
          .innerJoin(users, eq(users.id, taskAssignees.userId))
          .where(eq(taskAssignees.taskId, id)),
      };
    });
  }
  async act(u: User, pid: string, id: string, b: Record<string, unknown>) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "VALIDATION_ERROR", "작업 내용을 확인해주세요.");
    const action = String(b.action);
    if (
      !["complete", "approve", "changes_requested", "refresh"].includes(action)
    )
      fail(400, "VALIDATION_ERROR", "작업을 확인해주세요.");
    const note = bounded(b.note ?? "", 5000, action === "changes_requested");
    return this.database.db.transaction(async (tx) => {
      const task = await this.task(
        tx,
        u,
        pid,
        id,
        ["approve", "changes_requested"].includes(action)
          ? "approvals.work"
          : action === "refresh"
            ? "tasks.read"
            : "tasks.progress",
      );
      if (action !== "refresh" && b.expectedRevision !== task.workRevision)
        fail(
          409,
          "WORK_REVISION_CHANGED",
          "업무가 변경됐습니다. 최신 내용을 다시 확인해주세요.",
        );
      if (
        ["released", "deploying"].includes(task.status) ||
        (task.status === "done" && action !== "changes_requested")
      )
        fail(
          409,
          "NEW_REQUEST_REQUIRED",
          "완료된 업무의 변경은 새 개발 요청으로 등록해주세요.",
        );
      await this.predecessors(tx, task);
      const assigned = await tx
        .select()
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, id));
      const votes = await tx
        .select()
        .from(reviewers)
        .where(eq(reviewers.taskId, id));
      if (
        ["approve", "changes_requested"].includes(action) &&
        !votes.some((v) => v.userId === u.id)
      )
        fail(403, "REVIEWER_REQUIRED", "지정 승인자만 처리할 수 있습니다.");
      if (action === "changes_requested") {
        await this.reset(tx, task, u.id, note);
        return { status: "in_progress" };
      }
      if (task.completionMode === "deploy" && action !== "changes_requested") {
        const ancestors = await this.ancestorTasks(tx, task);
        const code = ancestors.filter((t) => t.completionMode === "code");
        if (code.some((t) => t.status !== "released"))
          fail(
            409,
            "DEPLOYMENT_REQUIRED",
            "선행 코드 업무를 실제 배포한 뒤 배포 단계를 완료해주세요.",
          );
        if (!/^https:\/\/[^\s]+$/.test(task.deploymentUrl ?? ""))
          fail(
            400,
            "DEPLOYMENT_URL_REQUIRED",
            "검증한 배포 URL을 저장해주세요.",
          );
      }
      let head = "";
      if (task.completionMode === "code") {
        await this.uniquePr(tx, task);
        const { pr } = await this.currentPr(task);
        head = pr.head.sha;
        if (task.reviewHeadSha && task.reviewHeadSha !== head) {
          await this.reset(
            tx,
            task,
            u.id,
            "PR 코드가 변경되어 재승인이 필요합니다.",
          );
          return { status: "in_progress", stale: true };
        }
      }
      if (action === "refresh") return { status: task.status };
      if (action === "complete") {
        if (!["todo", "in_progress"].includes(task.status))
          fail(409, "INVALID_TRANSITION", "진행 중 업무만 완료할 수 있습니다.");
        if (!assigned.some((a) => a.userId === u.id))
          fail(403, "ASSIGNEE_REQUIRED", "담당자만 완료할 수 있습니다.");
        if (!task.resultSummary.trim() || !task.verification.trim())
          fail(400, "RESULT_REQUIRED", "작업 결과와 검증 내용을 저장해주세요.");
        if (!votes.length)
          fail(409, "REVIEWER_REQUIRED", "작업 승인자를 지정해주세요.");
        for (const v of votes) {
          await this.eligibleReviewer(tx, u, pid, v.userId);
        }
        if (assigned.find((a) => a.userId === u.id)?.completedAt)
          fail(409, "ALREADY_COMPLETED", "이미 완료한 작업입니다.");
        await tx
          .update(taskAssignees)
          .set({ completedAt: sql`clock_timestamp()` })
          .where(
            and(eq(taskAssignees.taskId, id), eq(taskAssignees.userId, u.id)),
          );
        const all = assigned.every((a) => a.userId === u.id || a.completedAt);
        const status = all ? "review_pending" : "in_progress";
        await tx
          .update(tasks)
          .set({
            status,
            reviewHeadSha: head,
            version: randomUUID(),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, id));
        await this.record(tx, task, u.id, "completed", note, head);
        if(all) await recordTaskActivity(tx,task.id,u.id,"task_review_requested","담당자 전원이 작업을 완료하여 검토를 요청했습니다.");
        return { status };
      }
      if (task.status !== "review_pending")
        fail(
          409,
          "INVALID_TRANSITION",
          "모든 담당자가 완료한 뒤 승인할 수 있습니다.",
        );
      if (!assigned.length || assigned.some((a) => !a.completedAt))
        fail(409, "COMPLETION_REQUIRED", "모든 담당자의 완료가 필요합니다.");
      if (votes.find((v) => v.userId === u.id)?.status === "approved")
        fail(409, "ALREADY_APPROVED", "이미 승인한 작업입니다.");
      for (const v of votes) {
        await this.eligibleReviewer(tx, u, pid, v.userId);
      }
      await tx
        .update(reviewers)
        .set({ status: "approved", note, actedAt: sql`clock_timestamp()` })
        .where(and(eq(reviewers.taskId, id), eq(reviewers.userId, u.id)));
      const all = votes.every(
        (v) => v.userId === u.id || v.status === "approved",
      );
      const status = all
        ? task.completionMode === "code"
          ? "deploy_pending"
          : task.completionMode === "deploy"
            ? "released"
            : "done"
        : "review_pending";
      await tx
        .update(tasks)
        .set({
          status,
          approvedHeadSha: all ? head : "",
          version: randomUUID(),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(tasks.id, id));
      await this.record(tx, task, u.id, "approved", note, head);
      if (all) await this.unlock(tx, id);
      return { status };
    });
  }
  private async unlock(tx: Tx, id: string) {
    const children = await tx
      .select({ id: taskDependencies.taskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.predecessorId, id));
    for (const child of children) {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, child.id));
      if (task?.status === "blocked") {
        try {
          await this.predecessors(tx, task);
          await tx
            .update(tasks)
            .set({ status: "todo", version: randomUUID() })
            .where(eq(tasks.id, child.id));
        } catch {}
      }
    }
  }
  async deployments(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.requests.access(tx, u, pid);
      requireProjectPermission(access, "tasks.read");
      if (!access.isDeveloper)
        fail(403, "FORBIDDEN", "개발팀만 접근할 수 있습니다.");
      return {
        tasks: await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.projectId, pid),
              inArray(tasks.status, [
                "deploy_pending",
                "deploying",
                "released",
              ]),
            ),
          ),
        attempts: await tx
          .select()
          .from(attempts)
          .innerJoin(tasks, eq(tasks.id, attempts.taskId))
          .where(eq(tasks.projectId, pid)),
      };
    });
  }
  async deploy(u: User, pid: string, b: Record<string, unknown>) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "VALIDATION_ERROR", "배포할 업무를 선택해주세요.");
    if (!Array.isArray(b.taskIds) || !b.taskIds.length || b.taskIds.length > 50)
      fail(400, "VALIDATION_ERROR", "배포할 업무를 선택해주세요.");
    const selected = [...new Set((b.taskIds as string[]).map(uuid))];
    const ordered = await this.database.db.transaction(async (tx) => {
      const access = await this.requests.access(tx, u, pid);
      requireProjectPermission(access, "deploy.run");
      if (!access.isDeveloper)
        fail(403, "FORBIDDEN", "프로젝트 개발팀만 배포할 수 있습니다.");
      const found = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, pid), inArray(tasks.id, selected)))
        .orderBy(tasks.updatedAt, tasks.id);
      if (found.length !== selected.length)
        fail(404, "NOT_FOUND", "배포할 업무를 찾을 수 없습니다.");
      return found.map((t) => t.id);
    });
    const results = [];
    for (const id of ordered) {
      try {
        results.push({
          taskId: id,
          ...(await this.deployOne(u, pid, uuid(id))),
        });
      } catch (e: any) {
        results.push({
          taskId: id,
          status: "failed",
          error:
            e?.response?.message ??
            "배포 결과를 확인하지 못했습니다. 재시도해주세요.",
        });
      }
    }
    return { results };
  }
  private async deployOne(u: User, pid: string, id: string) {
    // The team lock serializes duplicates; retry reads GitHub first to recover an already merged PR.
    return this.database.db.transaction(async (tx) => {
      const task = await this.task(tx, u, pid, id, "deploy.run");
      if (task.status === "released" || task.status === "deploying")
        return { status: task.status };
      if (task.status !== "deploy_pending")
        fail(
          409,
          "INVALID_TRANSITION",
          "승인이 완료된 배포 대기 업무만 배포할 수 있습니다.",
        );
      await this.predecessors(tx, task);
      const codeAncestors = (await this.ancestorTasks(tx, task)).filter(
        (t) => t.completionMode === "code",
      );
      if (
        codeAncestors.some(
          (t) =>
            !["deploying", "released"].includes(t.status) || !t.mergeCommit,
        )
      )
        fail(
          409,
          "PREDECESSOR_DEPLOY_REQUIRED",
          "선행 코드 업무를 먼저 배포 목록에서 적용해주세요.",
        );
      const votes = await tx
        .select()
        .from(reviewers)
        .where(eq(reviewers.taskId, id));
      if (!votes.length || votes.some((v) => v.status !== "approved"))
        fail(409, "APPROVAL_REQUIRED", "전원 승인이 필요합니다.");
      for (const v of votes) {
        await this.eligibleReviewer(tx, u, pid, v.userId);
      }
      await this.uniquePr(tx, task);
      const { path, pr } = await this.currentPr(task, true);
      if (task.approvedHeadSha !== pr.head.sha) {
        await this.reset(
          tx,
          task,
          u.id,
          "배포 전 PR 코드 변경 확인: 재승인이 필요합니다.",
        );
        return { status: "in_progress", stale: true };
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"bridgain-pr:" + task.pullRequestUrl},0))`,
      );
      const [attempt] = await tx
        .insert(attempts)
        .values({
          taskId: id,
          actorId: u.id,
          status: "pending",
          headSha: pr.head.sha,
        })
        .returning();
      if ((pr as PullRequest & { mergeable?: boolean }).mergeable === false) {
        await this.reset(
          tx,
          task,
          u.id,
          "병합 충돌을 해결한 뒤 다시 승인받아주세요.",
        );
        await tx
          .update(attempts)
          .set({
            status: "failed",
            note: "병합 충돌",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(attempts.id, attempt.id));
        await recordTaskActivity(tx,task.id,u.id,"deploy_failed","병합 충돌",`attempt:${attempt.id}:failed`);
        return {
          status: "in_progress",
          error: "병합 충돌로 재작업이 필요합니다.",
        };
      }
      try {
        const merged = pr.merged
          ? { merged: true, sha: pr.merge_commit_sha }
          : await github<{ merged: boolean; sha: string }>(`${path}/merge`, {
              sha: pr.head.sha,
              merge_method: "merge",
            });
        if (!merged.merged || !/^[a-f0-9]{40}$/i.test(merged.sha ?? "")) {
          await this.reset(
            tx,
            task,
            u.id,
            "병합할 수 없습니다. 충돌과 검사를 확인한 뒤 다시 승인받아주세요.",
          );
          await tx
            .update(attempts)
            .set({
              status: "failed",
              note: "병합 거절: 재작업 필요",
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(attempts.id, attempt.id));
          await recordTaskActivity(tx,task.id,u.id,"deploy_failed","병합 거절",`attempt:${attempt.id}:failed`);
          return {
            status: "in_progress",
            error: "병합할 수 없어 재작업이 필요합니다.",
          };
        }
        await tx
          .update(tasks)
          .set({
            status: "deploying",
            mergeCommit: merged.sha!,
            version: randomUUID(),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, id));
        await tx
          .update(attempts)
          .set({ status: "merged", updatedAt: sql`clock_timestamp()` })
          .where(eq(attempts.id, attempt.id));
        await this.record(tx, task, u.id, "deploy_started", "", pr.head.sha);
        return { status: "deploying" };
      } catch (e: any) {
        await tx
          .update(attempts)
          .set({
            status: "failed",
            note: String(
              e?.response?.message ??
                "GitHub 배포 결과를 확인하지 못했습니다. 재시도해주세요.",
            ).slice(0, 5000),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(attempts.id, attempt.id));
        await recordTaskActivity(tx,task.id,u.id,"deploy_failed","배포 결과 확인 실패",`attempt:${attempt.id}:failed`);
        return {
          status: "deploy_pending",
          error:
            e?.response?.message ??
            "배포 결과를 확인하지 못했습니다. 재시도해주세요.",
        };
      }
    });
  }
  async deployed(u: User, pid: string, id: string, b: Record<string, unknown>) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "VALIDATION_ERROR", "배포 URL을 입력해주세요.");
    const url = String(b.url ?? "");
    if (!/^https:\/\/[^\s]+$/.test(url))
      fail(400, "VALIDATION_ERROR", "HTTPS 배포 URL을 입력해주세요.");
    return this.database.db.transaction(async (tx) => {
      const task = await this.task(tx, u, pid, id, "deploy.run");
      if (task.status !== "deploying" || !task.mergeCommit)
        fail(409, "INVALID_TRANSITION", "병합 후 배포 확인이 필요합니다.");
      await tx
        .update(tasks)
        .set({
          status: "released",
          deploymentUrl: url,
          version: randomUUID(),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(tasks.id, id));
      await this.record(tx, task, u.id, "released", url);
      await this.unlock(tx, id);
      return { status: "released" };
    });
  }
  async syncPullRequest(payload: Record<string, any>) {
    const pr = payload.pull_request;
    if (!pr?.html_url || pr.merged) return { updated: 0 };
    const linked = await this.database.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.pullRequestUrl, pr.html_url),
          eq(tasks.repositoryUrl, payload.repository?.html_url ?? ""),
        ),
      );
    let updated = 0;
    for (const t of linked) {
      if (
        !t.stageKey ||
        !t.reviewHeadSha ||
        ["released", "deploying"].includes(t.status)
      )
        continue;
      await this.database.db.transaction(async (tx) => {
        await tx
          .select({ id: teams.id })
          .from(teams)
          .innerJoin(projects, eq(projects.teamId, teams.id))
          .where(eq(projects.id, t.projectId))
          .for("update");
        const [current] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, t.id))
          .for("update");
        if (
          current &&
          current.reviewHeadSha &&
          (current.reviewHeadSha !== pr.head?.sha ||
            pr.state !== "open" ||
            pr.draft)
        ) {
          await this.reset(
            tx,
            current,
            t.createdBy,
            "PR 변경으로 재작업·재승인이 필요합니다.",
          );
          updated++;
        }
      });
    }
    return { updated };
  }
  async applyGitEvent(event: GitEvent) {
    if (event.kind !== "deployment" || !/^https:\/\/[^\s]+$/.test(event.url))
      return { updated: 0 };
    const linked = await this.database.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.repositoryUrl, event.repository),
          eq(tasks.status, "deploying"),
        ),
      );
    let updated = 0;
    for (const task of linked) {
      if (
        !task.stageKey ||
        task.liveBranch !== event.branch ||
        !task.mergeCommit ||
        ![event.commit, ...(event.includedCommits ?? [])].includes(
          task.mergeCommit,
        )
      )
        continue;
      await this.database.db.transaction(async (tx) => {
        await tx
          .select({ id: teams.id })
          .from(teams)
          .innerJoin(projects, eq(projects.teamId, teams.id))
          .where(eq(projects.id, task.projectId))
          .for("update");
        const [current] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .for("update");
        if (
          !current ||
          current.status !== "deploying" ||
          current.mergeCommit !== task.mergeCommit
        )
          return;
        await tx
          .update(tasks)
          .set({
            status: "released",
            deploymentUrl: event.url,
            version: randomUUID(),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, task.id));
        await this.record(
          tx,
          current,
          current.createdBy,
          "released",
          event.url,
          "",
          true,
        );
        await this.unlock(tx, task.id);
      });
      updated++;
    }
    return { updated };
  }
}
