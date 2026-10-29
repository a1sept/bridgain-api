import { recordTaskActivity } from "./activity-record.js";
import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, eq, desc, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  projectTasks as tasks,
  taskAssignees,
  taskReviewEvents as events,
} from "../db/schema/project-work.js";
import { teams, projects } from "../db/schema/workspace.js";
import { users } from "../db/schema/auth.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { ProjectWorkService } from "./project-work.service.js";
import { bounded, uuid } from "./workspace.service.js";
import { fail } from "../auth/security.js";
import {
  requireMergeReviewer,
  requireApprovedReview,
} from "./merge-review-policy.js";
import {
  github,
  pullRequestPath,
  checkPullRequest,
  type PullRequest,
} from "./github-pull-request.js";
type User = { id: string; displayName: string; accountType: string };
@Injectable()
export class TaskReviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
    private readonly work: ProjectWorkService,
  ) {}
  async syncPullRequest(payload: Record<string, any>) {
    const pr = payload?.pull_request;
    if (
      !pr ||
      ![
        "synchronize",
        "edited",
        "reopened",
        "converted_to_draft",
        "closed",
      ].includes(payload.action) ||
      pr.merged ||
      typeof pr.html_url !== "string" ||
      payload.repository?.html_url !== pr.base?.repo?.html_url
    )
      return { updated: 0 };
    const linked = await this.database.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.pullRequestUrl, pr.html_url),
          eq(tasks.mergeApprovalRequired, true),
          eq(tasks.repositoryUrl, payload.repository.html_url),
          eq(tasks.status, "in_progress"),
        ),
      );
    let updated = 0;
    for (const linkedTask of linked) {
      if (linkedTask.stageKey) continue;
      updated += await this.database.db.transaction(async (tx) => {
        await tx
          .select({ id: teams.id })
          .from(teams)
          .innerJoin(projects, eq(projects.teamId, teams.id))
          .where(eq(projects.id, linkedTask.projectId))
          .for("update");
        const [task] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, linkedTask.id))
          .for("update");
        if (
          !task ||
          task.status !== "in_progress" ||
          !task.mergeApprovalRequired ||
          task.pullRequestUrl !== pr.html_url ||
          !["pending", "approved"].includes(task.reviewStatus)
        )
          return 0;
        if (
          pr.state === "open" &&
          !pr.draft &&
          task.reviewHeadSha === pr.head?.sha &&
          task.reviewBaseSha === pr.base?.sha &&
          task.workBranch === pr.head?.ref &&
          task.liveBranch === pr.base?.ref
        )
          return 0;
        await tx
          .update(tasks)
          .set({
            version: randomUUID(),
            reviewStatus: "stale",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, task.id));
        await tx.insert(events).values({
          taskId: task.id,
          actorId: task.reviewRequestedBy || task.createdBy,
          action: "stale",
          headSha: task.reviewHeadSha,
          baseSha: task.reviewBaseSha,
          note: "GitHub에서 PR 변경·종료를 수신하여 검토를 무효화했습니다.",
        });
        return 1;
      });
    }
    return { updated };
  }
  async history(u: User, pid: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.requests.access(tx, u, pid);
      requireProjectPermission(access, "tasks.read");
      if (!access.isDeveloper)
        fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)));
      if (!task) fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      return {
        events: await tx
          .select({
            id: events.id,
            action: events.action,
            headSha: events.headSha,
            baseSha: events.baseSha,
            note: events.note,
            actorId: events.actorId,
            actorName: users.displayName,
            createdAt: events.createdAt,
          })
          .from(events)
          .innerJoin(users, eq(users.id, events.actorId))
          .where(eq(events.taskId, id))
          .orderBy(desc(events.createdAt))
          .limit(100),
      };
    });
  }
  async act(u: User, pid: string, id: string, body: Record<string, unknown>) {
    const action = body?.action;
    if (
      typeof action !== "string" ||
      !["request", "approve", "changes_requested", "refresh", "merge"].includes(
        action,
      )
    )
      fail(400, "VALIDATION_ERROR", "검토 작업을 확인해주세요.");
    const note = bounded(body.note ?? "", 5000, action === "changes_requested");
    return this.database.db.transaction(async (tx) => {
      // Same team lock as membership edits/task updates: revocation and merge cannot race.
      const access = await this.requests.access(tx, u, pid, true);
      requireProjectPermission(access, "tasks.read");
      if (action === "request")
        requireProjectPermission(access, "tasks.progress");
      if (action === "merge" && !access.permissions.includes("approvals.merge"))
        requireProjectPermission(access, "tasks.progress");
      if (["approve", "changes_requested"].includes(action as string))
        requireProjectPermission(access, "approvals.merge");
      if (!access.isDeveloper)
        fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)))
        .for("update");
      if (!task) return fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      if (task.stageKey)
        fail(
          409,
          "STAGED_WORK_REQUIRED",
          "단계별 업무는 작업 승인과 배포 목록에서 처리해주세요.",
        );
      if (!task.mergeApprovalRequired && action !== "merge")
        fail(
          409,
          "REVIEW_NOT_REQUIRED",
          "병합 승인이 필요한 업무에서 사용할 수 있습니다.",
        );
      if (action === "merge" && ["done", "released"].includes(task.status))
        return { status: task.status };
      if (task.status !== "in_progress")
        fail(
          409,
          "INVALID_TRANSITION",
          "진행 중인 업무만 병합 검토할 수 있습니다.",
        );
      const assigned = await tx
        .select()
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, id));
      const assigneeIds = assigned.map((a) => a.userId);
      if (action === "request" && !assigneeIds.includes(u.id))
        fail(
          403,
          "ASSIGNEE_REQUIRED",
          "배정된 담당자만 검토를 요청할 수 있습니다.",
        );
      if (
        ["approve", "changes_requested"].includes(action as string) &&
        task.mergeReviewerId !== u.id
      )
        fail(403, "REVIEWER_REQUIRED", "지정된 승인자만 검토할 수 있습니다.");
      if (
        action === "merge" &&
        !assigneeIds.includes(u.id) &&
        (!task.mergeApprovalRequired || task.mergeReviewerId !== u.id)
      )
        fail(403, "FORBIDDEN", "담당자 또는 지정 승인자만 병합할 수 있습니다.");
      if (
        task.mergeApprovalRequired &&
        ["approve", "changes_requested", "merge"].includes(action as string) &&
        (!task.reviewRequestId ||
          body.expectedReviewId !== task.reviewRequestId)
      )
        fail(
          409,
          "REVIEW_CHANGED",
          "검토 요청이 변경됐습니다. 업무를 다시 열어 내용을 확인해주세요.",
        );
      if (task.mergeApprovalRequired && action !== "refresh")
        await requireMergeReviewer(
          tx,
          pid,
          task.mergeReviewerId,
          assigneeIds,
          action === "request" ? u.id : task.reviewRequestedBy,
        );
      if (!task.resultSummary.trim() || !task.verification.trim())
        fail(
          400,
          "RESULT_REQUIRED",
          "검토 전에 변경 요약과 검증 결과를 저장해주세요.",
        );
      const path = pullRequestPath(
        pid,
        task.repositoryUrl,
        task.pullRequestUrl,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"bridgain-pr:" + task.pullRequestUrl}, 0))`,
      );
      if (action === "merge") {
        const guarded = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.pullRequestUrl, task.pullRequestUrl!),
              eq(tasks.mergeApprovalRequired, true),
            ),
          );
        if (guarded.some((t) => t.id !== id))
          fail(
            409,
            "OTHER_TASK_REVIEW_REQUIRED",
            "이 PR은 다른 업무의 병합 승인이 필요합니다. 해당 업무에서 병합해주세요.",
          );
      }
      const pr = await github<PullRequest>(path);
      checkPullRequest(pr, task, action === "merge");
      const record = async (event: string, message = note) => {
        await tx.insert(events).values({
          taskId: id,
          actorId: u.id,
          action: event,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
          note: message,
        });
        await recordTaskActivity(tx,id,u.id,({requested:"task_review_requested",approved:"task_approved",changes_requested:"task_changes_requested",stale:"task_invalidated",merged:"deploy_ready"} as Record<string,string>)[event] ?? "task_invalidated",message);
      };
      if (action === "request") {
        await tx
          .update(tasks)
          .set({
            version: randomUUID(),
            reviewStatus: "pending",
            reviewHeadSha: pr.head.sha,
            reviewBaseSha: pr.base.sha,
            reviewRequestedBy: u.id,
            reviewRequestId: randomUUID(),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, id));
        await record("requested");
        return { status: "pending" };
      }
      if (
        task.mergeApprovalRequired &&
        (task.reviewHeadSha !== pr.head.sha ||
          (!pr.merged && task.reviewBaseSha !== pr.base.sha))
      ) {
        await tx
          .update(tasks)
          .set({
            version: randomUUID(),
            reviewStatus: "stale",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(tasks.id, id));
        if (task.reviewStatus !== "stale")
          await record(
            "stale",
            "PR 또는 대상 브랜치가 변경되어 다시 검토가 필요합니다.",
          );
        return {
          status: "stale",
          message:
            "PR 또는 대상 브랜치가 변경됐습니다. 검토를 다시 요청해주세요.",
        };
      }
      if (action === "refresh") return { status: task.reviewStatus };
      if (action === "merge") {
        if (task.mergeApprovalRequired)
          requireApprovedReview(
            task,
            pr.head.sha,
            pr.merged ? undefined : pr.base.sha,
          );
        // SHA is checked atomically by GitHub, preventing new head commits from bypassing approval.
        const merged = pr.merged
          ? { merged: true, sha: pr.merge_commit_sha }
          : await github<{ merged: boolean; sha: string }>(`${path}/merge`, {
              sha: pr.head.sha,
              merge_method: "merge",
            });
        if (!merged.merged || !/^[a-f0-9]{40}$/i.test(merged.sha ?? ""))
          fail(
            409,
            "MERGE_FAILED",
            "PR이 병합되지 않았습니다. 필수 검사와 충돌 여부를 확인해주세요.",
          );
        const event = {
          kind: "merge" as const,
          repository: task.repositoryUrl!,
          branch: task.liveBranch,
          workBranch: task.workBranch,
          headSha: pr.head.sha,
          commit: merged.sha!,
          url: task.pullRequestUrl!,
        };
        await this.work.saveTask(
          u,
          pid,
          { status: "done", mergeCommit: merged.sha },
          id,
          event,
          tx,
        );
        await record(
          "merged",
          pr.merged ? "GitHub에서 완료된 병합 결과를 동기화했습니다." : note,
        );
        return { status: "done" };
      }
      if (task.reviewStatus !== "pending")
        fail(409, "REVIEW_NOT_PENDING", "검토 요청을 먼저 등록해주세요.");
      const status = action === "approve" ? "approved" : "changes_requested";
      await tx
        .update(tasks)
        .set({
          version: randomUUID(),
          reviewStatus: status,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(tasks.id, id));
      await record(status);
      return { status };
    });
  }
}
