import {parseRichDocument, richDocumentText} from "./rich-document.js";
import { recordRequestHandler } from "./request-handler.js";
import { randomUUID } from "node:crypto";
import {
  requireMergeReviewer,
  requireApprovedReview,
} from "./merge-review-policy.js";
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
  requestWorkflowLinks,
  taskApprovals,
  taskResultEntries,
  taskReviewEvents,
  meetingRequests,
  documentVersions,
  projectTasks as tasks,
  taskAssignees,
  taskDependencies,
  taskWorkReviewers,
  taskWorkEvents,
  taskRequests,
  projectMeetings as meetings,
  projectDocuments as documents,
  projectActivity as activity,
} from "../db/schema/project-work.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { bounded, uuid } from "./workspace.service.js";
import { fail } from "../auth/security.js";
import { parseStagePlans } from "./stage-plan-policy.js";
import { customerWorkflowStage } from "./workflow-progress.js";
import type { GitEvent } from "./git-events.controller.js";
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
export function requestProgress(statuses: string[]) {
  if (!statuses.length) return "received";
  return statuses.every((s) => s === "released")
    ? "released"
    : statuses.every((s) => ["done", "released"].includes(s))
      ? "completed"
      : statuses.some((s) => s !== "todo")
        ? "in_progress"
        : "received";
}
export function taskLifecycle(
  oldStatus: string,
  requested: string,
  branch: string,
  summary: string,
  commit: string,
  deployment: string | null,
) {
  const status = choice(requested, ["todo", "in_progress", "done", "released"]);
  const allowed: Record<string, string[]> = {
    todo: ["todo", "in_progress"],
    in_progress: ["in_progress", "done"],
    done: ["done", "in_progress", "released"],
    released: ["released", "in_progress"],
  };
  if (!allowed[oldStatus]?.includes(status))
    fail(400, "INVALID_TRANSITION", "업무 진행 순서를 확인해주세요.");
  const next = status === "todo" && branch ? "in_progress" : status;
  if (next !== "todo" && !branch.trim())
    fail(400, "BRANCH_REQUIRED", "작업 브랜치를 연결해주세요.");
  if (
    ["done", "released"].includes(next) &&
    (!summary.trim() || !/^[a-f0-9]{7,40}$/i.test(commit))
  )
    fail(400, "RESULT_REQUIRED", "개발 결과와 병합 커밋을 기록해주세요.");
  if (next === "released" && !deployment)
    fail(
      400,
      "DEPLOYMENT_REQUIRED",
      "실제 배포 성공을 확인할 수 있는 링크를 입력해주세요.",
    );
  return next;
}
@Injectable()
export class ProjectWorkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private run<T>(fn: (tx: Tx) => Promise<T>, existingTx?: Tx) {
    return existingTx ? fn(existingTx) : this.database.db.transaction(fn);
  }
  private async access(
    tx: Tx,
    u: User,
    pid: string,
    lock = false,
    permission = "tasks.read",
  ) {
    const access = await this.requests.access(tx, u, pid, lock);
    requireProjectPermission(access, permission);
    if (!access.isDeveloper)
      fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
    return access;
  }
  private async event(
    tx: Tx,
    u: User,
    pid: string,
    id: string,
    kind: string,
    title: string,
  ) {
    await tx.insert(activity).values({
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
  private async taskOutput(
    tx: Tx,
    row: typeof tasks.$inferSelect,
    permissions?: string[],
  ) {
    const assignees = await tx
      .select({
        userId: users.id,
        displayName: users.displayName,
        completedAt: taskAssignees.completedAt,
      })
      .from(taskAssignees)
      .innerJoin(users, eq(users.id, taskAssignees.userId))
      .where(eq(taskAssignees.taskId, row.id));
    const requests =
      permissions && !permissions.includes("requests.read")
        ? []
        : await tx
            .select({ id: projectRequests.id, title: projectRequests.title })
            .from(taskRequests)
            .innerJoin(
              projectRequests,
              eq(projectRequests.id, taskRequests.requestId),
            )
            .where(eq(taskRequests.taskId, row.id));
    return {
      ...row,
      resultEntries: await tx
        .select({ entry: taskResultEntries, actorName: users.displayName })
        .from(taskResultEntries)
        .innerJoin(users, eq(users.id, taskResultEntries.actorId))
        .where(eq(taskResultEntries.taskId, row.id))
        .orderBy(desc(taskResultEntries.createdAt)),
      documentVersions:
        permissions && !permissions.includes("documents.read")
          ? []
          : await tx
              .select({
                id: documentVersions.id,
                documentId: documentVersions.documentId,
                title: documentVersions.title,
                changeSummary: documentVersions.changeSummary,
                createdAt: documentVersions.createdAt,
              })
              .from(documentVersions)
              .where(eq(documentVersions.taskId, row.id))
              .orderBy(desc(documentVersions.createdAt)),
      assignees,
      completedAssigneeIds: assignees
        .filter((x) => x.completedAt)
        .map((x) => x.userId),
      workReviewers: await tx
        .select({
          userId: users.id,
          displayName: users.displayName,
          status: taskWorkReviewers.status,
          note: taskWorkReviewers.note,
          actedAt: taskWorkReviewers.actedAt,
        })
        .from(taskWorkReviewers)
        .innerJoin(users, eq(users.id, taskWorkReviewers.userId))
        .where(eq(taskWorkReviewers.taskId, row.id)),
      dependencies: await Promise.all(
        (
          await tx
            .select({
              predecessorId: tasks.id,
              title: tasks.title,
              status: tasks.status,
              completionMode: tasks.completionMode,
              resultSummary: tasks.resultSummary,
              verification: tasks.verification,
              workRevision: tasks.workRevision,
            })
            .from(taskDependencies)
            .innerJoin(tasks, eq(tasks.id, taskDependencies.predecessorId))
            .where(eq(taskDependencies.taskId, row.id))
        ).map(async (dep) => {
          const [approved] = await tx
            .select({ createdAt: taskWorkEvents.createdAt })
            .from(taskWorkEvents)
            .where(
              and(
                eq(taskWorkEvents.taskId, dep.predecessorId),
                eq(taskWorkEvents.action, "approved"),
                eq(taskWorkEvents.revision, dep.workRevision),
              ),
            )
            .orderBy(desc(taskWorkEvents.createdAt))
            .limit(1);
          const finalized =
            !!approved &&
            ["done", "deploy_pending", "deploying", "released"].includes(
              dep.status,
            );
          return {
            ...dep,
            resultSummary: finalized ? dep.resultSummary : "",
            verification: finalized ? dep.verification : "",
            documentVersions:
              !finalized ||
              (permissions && !permissions.includes("documents.read"))
                ? []
                : await tx
                    .select({
                      id: documentVersions.id,
                      documentId: documentVersions.documentId,
                      title: documentVersions.title,
                      url: documentVersions.url,
                    })
                    .from(documentVersions)
                    .where(
                      and(
                        eq(documentVersions.taskId, dep.predecessorId),
                        sql`${documentVersions.createdAt} <= ${approved.createdAt}`,
                      ),
                    )
                    .orderBy(desc(documentVersions.createdAt)),
          };
        }),
      ),
      workEvents: await tx
        .select({ event: taskWorkEvents, actorName: users.displayName })
        .from(taskWorkEvents)
        .innerJoin(users, eq(users.id, taskWorkEvents.actorId))
        .where(eq(taskWorkEvents.taskId, row.id))
        .orderBy(desc(taskWorkEvents.createdAt)),
      requests,
      assigneeIds: assignees.map((x) => x.userId),
      requestIds: requests.map((x) => x.id),
    };
  }
  async listTasks(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.access(tx, u, pid);
      const rows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.projectId, pid))
        .orderBy(desc(tasks.createdAt));
      return {
        tasks: await Promise.all(
          rows.map((r) => this.taskOutput(tx, r, access.permissions)),
        ),
      };
    });
  }
  async saveTask(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
    gitEvent?: GitEvent,
    existingTx?: Tx,
  ) {
    return this.run(async (tx) => {
      const taskAccess = await this.requests.access(tx, u, pid, true);
      if (!taskAccess.isDeveloper)
        fail(403, "FORBIDDEN", "프로젝트 개발팀만 접근할 수 있습니다.");
      requireProjectPermission(
        taskAccess,
        gitEvent?.kind === "merge" &&
          taskAccess.permissions.includes("approvals.merge")
          ? "approvals.merge"
          : "tasks.progress",
      );
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "VALIDATION_ERROR", "변경 내용을 확인해주세요.");
      if (!id)
        fail(
          403,
          "APPROVAL_REQUIRED",
          "업무는 승인 요청이 승인된 뒤 생성됩니다.",
        );
      let old: typeof tasks.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      }
      if (
        old &&
        b.expectedVersion !== undefined &&
        b.expectedVersion !== old.version
      )
        fail(
          409,
          "TASK_CHANGED",
          "다른 작업으로 업무가 변경되었습니다. 최신 내용을 다시 열어 확인해주세요.",
        );
      if (
        gitEvent &&
        old &&
        (old.repositoryUrl !== gitEvent.repository ||
          old.liveBranch !== gitEvent.branch ||
          (gitEvent.kind === "merge"
            ? old.status !== "in_progress" ||
              old.workBranch !== gitEvent.workBranch
            : old.status !== "done" ||
              ![gitEvent.commit, ...(gitEvent.includedCommits ?? [])].includes(
                old.mergeCommit,
              )))
      )
        return {
          task: await this.taskOutput(tx, old, taskAccess.permissions),
          ignored: true,
        };
      if (
        old?.status === "released" &&
        b.status !== undefined &&
        b.status !== "released"
      )
        fail(
          409,
          "TASK_RELEASED",
          "배포 완료 후 변경은 새 요청으로 등록해주세요.",
        );
      const current = old ? await this.taskOutput(tx, old) : undefined;
      if (old?.stageKey) {
        if (gitEvent)
          fail(
            409,
            "STAGED_ACTION_REQUIRED",
            "단계 업무는 작업 승인·배포 절차를 사용해주세요.",
          );
        if (!current?.assigneeIds.includes(u.id))
          fail(
            403,
            "TASK_ASSIGNEE_REQUIRED",
            "배정된 담당자만 업무를 진행할 수 있습니다.",
          );
        if (
          !["todo", "in_progress"].includes(old.status) ||
          current?.assignees.some((x) => x.completedAt)
        )
          fail(
            409,
            "WORK_LOCKED",
            "완료 제출한 작업은 재작업 요청 후 수정할 수 있습니다.",
          );
        const mutable = new Set([
          "expectedVersion",
          "status",
          "repositoryUrl",
          "workBranch",
          "liveBranch",
          "pullRequestUrl",
          "resultSummary",
          "dbChanges",
          "apiChanges",
          "frontendChanges",
          "verification",
        ]);
        if (old.completionMode === "deploy") mutable.add("deploymentUrl");
        for (const key of Object.keys(b))
          if (!mutable.has(key))
            fail(
              403,
              "APPROVED_SCOPE_LOCKED",
              "승인된 업무 범위와 배포 정보는 수정할 수 없습니다.",
            );
        const status =
          b.status === undefined
            ? old.status
            : choice(b.status, ["todo", "in_progress"]);
        if (old.status === "in_progress" && status !== "in_progress")
          fail(
            409,
            "INVALID_TRANSITION",
            "작업 완료 또는 재작업 절차를 사용해주세요.",
          );
        const values: Partial<typeof tasks.$inferInsert> = {
          status,
          version: randomUUID(),
          updatedAt: new Date(),
        };
        for (const key of [
          "resultSummary",
          "dbChanges",
          "apiChanges",
          "frontendChanges",
          "verification",
        ] as const)
          if (b[key] !== undefined) values[key] = bounded(b[key], 10000, false);
        for (const key of ["repositoryUrl", "pullRequestUrl"] as const)
          if (b[key] !== undefined) values[key] = documentUrl(b[key]);
        if (old.completionMode === "deploy" && b.deploymentUrl !== undefined)
          values.deploymentUrl = documentUrl(b.deploymentUrl);
        if (b.workBranch !== undefined)
          values.workBranch = bounded(b.workBranch, 200, false);
        if (b.liveBranch !== undefined && b.liveBranch !== "main")
          fail(400, "MAIN_REQUIRED", "배포 대상 브랜치는 main입니다.");
        const branch = values.workBranch ?? old.workBranch;
        if (
          branch &&
          (!/^(?!.*(?:\.\.|@\{|[~^:?*\\\s]))(?![/.])(?!.*[/.]$).+$/.test(
            branch,
          ) ||
            branch === "main")
        )
          fail(400, "INVALID_BRANCH", "유효한 작업 브랜치를 입력해주세요.");
        const [row] = await tx
          .update(tasks)
          .set(values)
          .where(eq(tasks.id, old.id))
          .returning();
        await this.event(tx, u, pid, old.id, "task_updated", old.title);
        return { task: await this.taskOutput(tx, row, taskAccess.permissions) };
      }
      if (old && !gitEvent) {
        if (!current?.assigneeIds.includes(u.id))
          fail(
            403,
            "TASK_ASSIGNEE_REQUIRED",
            "배정된 담당자만 업무를 진행할 수 있습니다.",
          );
        for (const key of [
          "title",
          "description",
          "descriptionDocument",
          "priority",
          "dueDate",
          "assigneeIds",
          "requestIds",
        ] as const) {
          const previous =
            key === "assigneeIds" || key === "requestIds"
              ? current?.[key]
              : old[key];
          if (
            b[key] !== undefined &&
            JSON.stringify(b[key]) !== JSON.stringify(previous)
          )
            fail(
              403,
              "APPROVED_SCOPE_LOCKED",
              "승인된 업무의 범위와 담당자, 요청 연결은 변경할 수 없습니다.",
            );
        }
      }
      const descriptionDocument = b.descriptionDocument === undefined ? old?.descriptionDocument ?? null : parseRichDocument(b.descriptionDocument);
      const title = bounded(b?.title ?? old?.title, 160),
        description = bounded(
          descriptionDocument ? richDocumentText(descriptionDocument) : b?.description ?? old?.description ?? "",
          10000,
          false,
        ),
        status = choice(b?.status ?? old?.status ?? "todo", [
          "todo",
          "in_progress",
          "done",
          "released",
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
      const metadata = {
        repositoryUrl: documentUrl(
          b.repositoryUrl === undefined
            ? (old?.repositoryUrl ?? null)
            : b.repositoryUrl,
        ),
        workBranch: bounded(b.workBranch ?? old?.workBranch ?? "", 200, false),
        liveBranch: bounded(b.liveBranch ?? old?.liveBranch ?? "main", 200),
        pullRequestUrl: documentUrl(
          b.pullRequestUrl === undefined
            ? (old?.pullRequestUrl ?? null)
            : b.pullRequestUrl,
        ),
        mergeCommit: bounded(
          b.mergeCommit ?? old?.mergeCommit ?? "",
          40,
          false,
        ),
        deploymentUrl: documentUrl(
          b.deploymentUrl === undefined
            ? (old?.deploymentUrl ?? null)
            : b.deploymentUrl,
        ),
        resultSummary: bounded(
          b.resultSummary ?? old?.resultSummary ?? "",
          10000,
          false,
        ),
        dbChanges: bounded(b.dbChanges ?? old?.dbChanges ?? "", 10000, false),
        apiChanges: bounded(
          b.apiChanges ?? old?.apiChanges ?? "",
          10000,
          false,
        ),
        frontendChanges: bounded(
          b.frontendChanges ?? old?.frontendChanges ?? "",
          10000,
          false,
        ),
        verification: bounded(
          b.verification ?? old?.verification ?? "",
          10000,
          false,
        ),
      };
      if (
        old &&
        old.workBranch &&
        (metadata.workBranch !== old.workBranch ||
          metadata.repositoryUrl !== old.repositoryUrl ||
          metadata.liveBranch !== old.liveBranch)
      ) {
        if (status !== "in_progress")
          fail(
            400,
            "INVALID_TRANSITION",
            "새 브랜치 작업은 진행 중 상태로 시작해주세요.",
          );
        metadata.mergeCommit = "";
        metadata.deploymentUrl = null;
        metadata.pullRequestUrl = null;
      }
      if (
        (metadata.workBranch !== (old?.workBranch ?? "") ||
          metadata.repositoryUrl !== (old?.repositoryUrl ?? null) ||
          metadata.liveBranch !== (old?.liveBranch ?? "main")) &&
        metadata.workBranch &&
        !assigneeIds.includes(u.id)
      )
        fail(
          403,
          "ASSIGNEE_REQUIRED",
          "배정된 개발 담당자가 작업 브랜치를 연결할 수 있습니다.",
        );
      if (
        metadata.workBranch &&
        (!metadata.repositoryUrl || !assigneeIds.length)
      )
        fail(400, "BRANCH_REQUIRED", "저장소와 개발 담당자를 지정해주세요.");
      if (
        metadata.workBranch &&
        (!/^(?!.*(?:\.\.|@\{|[~^:?*\\\s]))(?![/.])(?!.*[/.]$).+$/.test(
          metadata.workBranch,
        ) ||
          metadata.workBranch === metadata.liveBranch)
      )
        fail(
          400,
          "INVALID_BRANCH",
          "라이브 브랜치와 다른 유효한 작업 브랜치를 입력해주세요.",
        );
      const nextStatus = taskLifecycle(
        old?.status ?? "todo",
        status,
        metadata.workBranch,
        metadata.resultSummary,
        metadata.mergeCommit,
        metadata.deploymentUrl,
      );
      if (
        b.mergeApprovalRequired !== undefined &&
        typeof b.mergeApprovalRequired !== "boolean"
      )
        fail(400, "VALIDATION_ERROR", "병합 승인 필요 여부를 확인해주세요.");
      const mergeApprovalRequired = (b.mergeApprovalRequired ??
        old?.mergeApprovalRequired ??
        false) as boolean;
      const mergeReviewerId =
        b.mergeReviewerId === undefined
          ? (old?.mergeReviewerId ?? null)
          : b.mergeReviewerId === null || b.mergeReviewerId === ""
            ? null
            : uuid(b.mergeReviewerId).toLowerCase();
      const policyChanged =
        mergeApprovalRequired !== (old?.mergeApprovalRequired ?? false) ||
        mergeReviewerId !== (old?.mergeReviewerId ?? null);
      if (policyChanged) {
        const permission = await this.requests.access(tx, u, pid);
        if (!permission.canAssign)
          fail(
            403,
            "FORBIDDEN",
            "관리자만 병합 승인 필요 여부와 승인자를 변경할 수 있습니다.",
          );
        if (old && ["done", "released"].includes(old.status))
          fail(
            409,
            "REOPEN_REQUIRED",
            "완료된 업무는 먼저 진행 중으로 다시 열어주세요.",
          );
      }
      if (mergeApprovalRequired && (policyChanged || !old))
        await requireMergeReviewer(tx, pid, mergeReviewerId, assigneeIds);
      const reviewChanged =
        !!old &&
        (policyChanged ||
          [
            "title",
            "description",
            "repositoryUrl",
            "workBranch",
            "liveBranch",
            "pullRequestUrl",
            "resultSummary",
            "dbChanges",
            "apiChanges",
            "frontendChanges",
            "verification",
          ].some((key) => {
            const next = { title, description, ...metadata } as Record<
              string,
              unknown
            >;
            return (
              next[key] !== (old as unknown as Record<string, unknown>)[key]
            );
          }) ||
          [...assigneeIds].sort().join() !==
            [...(current?.assigneeIds ?? [])].sort().join() ||
          [...requestIds].sort().join() !==
            [...(current?.requestIds ?? [])].sort().join() ||
          (["done", "released"].includes(old.status) &&
            nextStatus === "in_progress"));
      // Serialize policy edits and merge attempts even when another task links the same PR.
      for (const url of [
        ...new Set(
          [old?.pullRequestUrl, metadata.pullRequestUrl].filter(
            (v): v is string => !!v,
          ),
        ),
      ].sort())
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"bridgain-pr:" + url}, 0))`,
        );
      const reviewStatus = reviewChanged
        ? "none"
        : (old?.reviewStatus ?? "none");
      if (
        mergeApprovalRequired &&
        nextStatus === "done" &&
        (old?.status !== nextStatus || reviewChanged)
      ) {
        if (!old || reviewChanged)
          return fail(
            409,
            "MERGE_APPROVAL_REQUIRED",
            "변경 사항을 저장하고 다시 검토를 요청해주세요.",
          );
        await requireMergeReviewer(
          tx,
          pid,
          mergeReviewerId,
          assigneeIds,
          old.reviewRequestedBy,
        );
        if (
          !gitEvent ||
          gitEvent.kind !== "merge" ||
          gitEvent.url !== old.pullRequestUrl
        )
          return fail(
            409,
            "MERGE_REQUIRED",
            "승인 후 업무의 병합 버튼으로 실제 PR을 병합해주세요.",
          );
        requireApprovedReview(old, gitEvent.headSha);
      }
      if (
        old?.mergeApprovalRequired &&
        ["done", "released"].includes(old.status) &&
        nextStatus !== "in_progress" &&
        (reviewChanged || metadata.mergeCommit !== old.mergeCommit)
      )
        fail(
          409,
          "REOPEN_REQUIRED",
          "승인된 개발 결과를 변경하려면 업무를 진행 중으로 다시 열어주세요.",
        );
      if (old && reviewChanged && old.reviewStatus !== "none")
        await tx.insert(taskReviewEvents).values({
          taskId: old.id,
          actorId: u.id,
          action: "invalidated",
          headSha: old.reviewHeadSha,
          baseSha: old.reviewBaseSha,
          note: "업무 내용·담당자·승인 정책 또는 Git 연결 변경으로 검토가 초기화되었습니다.",
        });
      const values = {
        version: randomUUID(),
        mergeApprovalRequired,
        mergeReviewerId,
        reviewStatus,
        ...(reviewChanged
          ? {
              reviewHeadSha: "",
              reviewBaseSha: "",
              reviewRequestedBy: null,
              reviewRequestId: null,
            }
          : {}),
        title,
        description,
        descriptionDocument,
        status: nextStatus,
        priority,
        dueDate: due,
        ...metadata,
      };
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
      await this.syncRequests(tx, u, pid, [
        ...new Set([...requestIds, ...(current?.requestIds ?? [])]),
      ]);
      return { task: await this.taskOutput(tx, row, taskAccess.permissions) };
    }, existingTx).catch((error: unknown) => {
      const wrapped = error as {
        code?: string;
        constraint?: string;
        cause?: { code?: string; constraint?: string };
      };
      const detail = wrapped?.cause ?? wrapped;
      if (
        detail?.code === "23505" &&
        detail.constraint === "task_approval_pr_unique"
      )
        fail(
          409,
          "PR_ALREADY_LINKED",
          "이 PR은 이미 승인 필수 업무에 연결되어 있습니다.",
        );
      throw error;
    });
  }
  async listResultEntries(u: User, pid: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, false, "tasks.read");
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)));
      if (!task) fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      return {
        entries: await tx
          .select({ entry: taskResultEntries, actorName: users.displayName })
          .from(taskResultEntries)
          .innerJoin(users, eq(users.id, taskResultEntries.actorId))
          .where(eq(taskResultEntries.taskId, id))
          .orderBy(desc(taskResultEntries.createdAt)),
      };
    });
  }
  async appendResult(
    u: User,
    pid: string,
    id: string,
    b: Record<string, unknown>,
    existingTx?: Tx,
  ) {
    if (!b || typeof b !== "object" || Array.isArray(b))
      fail(400, "VALIDATION_ERROR", "추가할 기록을 확인해주세요.");
    return this.run(async (tx) => {
      await this.access(tx, u, pid, true, "tasks.progress");
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, uuid(id)), eq(tasks.projectId, pid)))
        .for("update");
      if (!task) return fail(404, "NOT_FOUND", "업무를 찾을 수 없습니다.");
      const assigned = await tx
        .select()
        .from(taskAssignees)
        .where(
          and(eq(taskAssignees.taskId, id), eq(taskAssignees.userId, u.id)),
        );
      if (!assigned.length)
        fail(
          403,
          "TASK_ASSIGNEE_REQUIRED",
          "배정된 담당자만 업무 결과를 기록할 수 있습니다.",
        );
      if (b.expectedVersion !== task.version)
        fail(
          409,
          "TASK_CHANGED",
          "업무가 변경되었습니다. 최신 업무를 확인하고 기록을 추가해주세요.",
        );
      if (!["done", "released"].includes(task.status))
        fail(
          409,
          "TASK_NOT_COMPLETED",
          "완료된 업무에 후속 기록을 추가할 수 있습니다.",
        );
      const values = {
        changeSummary: bounded(b.changeSummary, 1000),
        resultSummary: bounded(b.resultSummary ?? "", 10000, false),
        dbChanges: bounded(b.dbChanges ?? "", 10000, false),
        apiChanges: bounded(b.apiChanges ?? "", 10000, false),
        frontendChanges: bounded(b.frontendChanges ?? "", 10000, false),
        verification: bounded(b.verification ?? "", 10000, false),
      };
      const [entry] = await tx
        .insert(taskResultEntries)
        .values({ ...values, taskId: id, actorId: u.id })
        .returning();
      await this.event(
        tx,
        u,
        pid,
        id,
        "task_result_added",
        values.changeSummary,
      );
      return { entry };
    }, existingTx);
  }
  async listMeetings(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, false, "meetings.read");
      const rows = await tx
        .select()
        .from(meetings)
        .where(eq(meetings.projectId, pid))
        .orderBy(desc(meetings.scheduledAt));
      return {
        meetings: await Promise.all(
          rows.map(async (row) => ({
            ...row,
            requests: await tx
              .select()
              .from(meetingRequests)
              .where(eq(meetingRequests.meetingId, row.id)),
          })),
        ),
      };
    });
  }
  async meetingAction(u:User,pid:string,id:string,b:Record<string,unknown>) {
    const action=choice(b?.action,["start","complete"]);
    return this.database.db.transaction(async tx=>{
      await this.access(tx,u,pid,true,"meetings.update");
      const [meeting]=await tx.select().from(meetings).where(and(eq(meetings.id,uuid(id)),eq(meetings.projectId,pid))).for("update");
      if(!meeting)fail(404,"NOT_FOUND","회의를 찾을 수 없습니다.");
      const next=action==="start"?"in_progress":"completed";
      if(meeting.status===next)return {meeting};
      if((action==="start"&&meeting.status!=="scheduled")||(action==="complete"&&meeting.status!=="in_progress"))fail(409,"INVALID_TRANSITION","회의 진행 상태를 확인해주세요.");
      const [row]=await tx.update(meetings).set({status:next,...(action==="start"?{startedAt:sql`clock_timestamp()`}:{endedAt:sql`clock_timestamp()`}),updatedAt:sql`clock_timestamp()`}).where(eq(meetings.id,meeting.id)).returning();
      await this.event(tx,u,pid,id,action==="start"?"meeting_started":"meeting_completed",meeting.title);
      return {meeting:row};
    });
  }
  async saveMeeting(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
    existingTx?: Tx,
  ) {
    return this.run(async (tx) => {
      await this.access(
        tx,
        u,
        pid,
        true,
        id ? "meetings.update" : "meetings.create",
      );
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "VALIDATION_ERROR", "변경 내용을 확인해주세요.");
      let old: typeof meetings.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(meetings)
          .where(and(eq(meetings.id, uuid(id)), eq(meetings.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "회의를 찾을 수 없습니다.");
      }
      if (b.status !== undefined && b.status !== (old?.status ?? "scheduled"))
        fail(409, "MEETING_ACTION_REQUIRED", "회의 시작하기 또는 완전 마무리 버튼을 사용해주세요.");
      if (old?.decisionStatus === "final")
        fail(409,"MEETING_FINAL","최종안 내용은 수정할 수 없습니다.");
      const decisionStatus = choice(
        b.decisionStatus ?? old?.decisionStatus ?? "draft",
        ["draft", "final"],
      );
      if (decisionStatus === "final")
        fail(
          403,
          "APPROVAL_REQUIRED",
          "최종안은 승인 요청 후 필수 승인자 전원이 승인해야 합니다.",
        );
      if (old) {
        const pending = await tx
          .select()
          .from(taskApprovals)
          .where(
            and(
              eq(taskApprovals.meetingId, old.id),
              eq(taskApprovals.status, "pending"),
            ),
          );
        if (pending.length)
          fail(
            409,
            "APPROVAL_PENDING",
            "승인 요청을 취소한 후 회의를 변경해주세요.",
          );
      }
      const previous = old
        ? await tx
            .select()
            .from(meetingRequests)
            .where(eq(meetingRequests.meetingId, old.id))
        : [];
      const source =
        b.requests ??
        (previous.length
          ? previous
          : (b.requestId ?? old?.requestId)
            ? [{ requestId: b.requestId ?? old?.requestId }]
            : []);
      if (!Array.isArray(source) || source.length > 50)
        fail(400, "VALIDATION_ERROR", "회의 요청은 최대 50개입니다.");
      const plans = (source as Record<string, unknown>[]).map((item) => {
        if (!item || typeof item !== "object")
          fail(400, "VALIDATION_ERROR", "요청 메모를 확인해주세요.");
        return {
          requestId: uuid(item.requestId).toLowerCase(),
          discussionStatus: choice(item.discussionStatus ?? previous.find(p => p.requestId === item.requestId)?.discussionStatus ?? "unreviewed", ["unreviewed", "discussed", "deferred"]),
          planning: bounded(item.planning ?? "", 10000, false),
          uiNotes: bounded(item.uiNotes ?? "", 10000, false),
          apiNotes: bounded(item.apiNotes ?? "", 10000, false),
          dbNotes: bounded(item.dbNotes ?? "", 10000, false),
          priority: choice(item.priority ?? "normal", [
            "urgent",
            "high",
            "normal",
            "low",
          ]),
          assigneeIds: ids(item.assigneeIds ?? []),
          stages: parseStagePlans(item.stages ?? undefined, true),
        };
      });
      if (new Set(plans.map((x) => x.requestId)).size !== plans.length)
        fail(400, "VALIDATION_ERROR", "같은 요청을 중복 연결할 수 없습니다.");
      for (const plan of plans) {
        await this.links(tx, pid, plan.assigneeIds, [plan.requestId]);
      }
      // The project/team lock serializes all workflow writes, including transfers.
      for (const plan of plans) {
        await tx
          .select()
          .from(projectRequests)
          .where(eq(projectRequests.id, plan.requestId))
          .for("update");
        const tasksLinked = await tx
          .select()
          .from(taskRequests)
          .where(eq(taskRequests.requestId, plan.requestId));
        if (tasksLinked.length)
          fail(
            409,
            "REQUEST_TASK_LINKED",
            "이미 업무화된 요청은 회의에 다시 연결할 수 없습니다.",
          );
        const [link] = await tx
          .select()
          .from(requestWorkflowLinks)
          .where(eq(requestWorkflowLinks.requestId, plan.requestId));
        if (link?.approvalId) {
          const [approval] = await tx
            .select()
            .from(taskApprovals)
            .where(eq(taskApprovals.id, link.approvalId));
          if (approval?.status === "pending" || approval?.status === "approved")
            fail(
              409,
              "APPROVAL_PENDING",
              "기존 승인 요청을 먼저 취소해주세요.",
            );
        }
        if (link?.meetingId && link.meetingId !== old?.id) {
          const [sourceMeeting] = await tx
            .select()
            .from(meetings)
            .where(eq(meetings.id, link.meetingId));
          if (sourceMeeting.decisionStatus === "final")
            fail(
              409,
              "MEETING_FINAL",
              "승인된 회의에서 요청을 이동할 수 없습니다.",
            );
          const confirmed = b.transferFromMeetingIds as
            Record<string, unknown> | undefined;
          if (confirmed?.[plan.requestId] !== link.meetingId)
            fail(
              409,
              "REQUEST_MEETING_LINKED",
              `이 요청은 '${sourceMeeting.title}' 회의에 연결되어 있습니다. 기존 회의에서 제외하고 이동하려면 확인해주세요. (${link.meetingId})`,
            );
          await tx.insert(requestEvents).values({
            requestId: plan.requestId,
            kind: "meeting_transfer",
            body: "연결 회의가 변경되었습니다.",
            actorId: u.id,
          });
          // Keep old notes in history, but remove the current association.
          await tx.insert(activity).values({
            projectId: pid,
            entityId: link.meetingId,
            kind: "request_transferred",
            body: JSON.stringify({
              requestId: plan.requestId,
              previous: await tx
                .select()
                .from(meetingRequests)
                .where(
                  and(
                    eq(meetingRequests.meetingId, link.meetingId),
                    eq(meetingRequests.requestId, plan.requestId),
                  ),
                ),
            }),
            actorId: u.id,
          });
          await tx
            .delete(meetingRequests)
            .where(
              and(
                eq(meetingRequests.meetingId, link.meetingId),
                eq(meetingRequests.requestId, plan.requestId),
              ),
            );
          await tx
            .update(meetings)
            .set({ requestId: null })
            .where(
              and(
                eq(meetings.id, link.meetingId),
                eq(meetings.requestId, plan.requestId),
              ),
            );
        }
      }
      const duration = b?.durationMinutes ?? old?.durationMinutes ?? 60;
      if (
        typeof duration !== "number" ||
        !Number.isInteger(duration) ||
        duration < 15 ||
        duration > 480
      )
        fail(400, "VALIDATION_ERROR", "회의 시간은 15~480분입니다.");
      const finalApproverIds = ids(b.finalApproverIds ?? old?.finalApproverIds ?? []);
      await this.links(tx, pid, finalApproverIds, []);
      const requestId = plans[0]?.requestId ?? null;
      const values = {
        title: bounded(b?.title ?? old?.title, 160),
        scheduledAt: meetingDate(
          b?.scheduledAt ?? old?.scheduledAt.toISOString(),
        ),
        durationMinutes: duration as number,
        finalApproverIds,
        decisionStatus,
        location: bounded(b?.location ?? old?.location ?? "", 1000, false),
        notes: bounded(b?.notes ?? old?.notes ?? "", 20000, false),
        status: old?.status ?? "scheduled",
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
      if (old)
        await tx
          .delete(meetingRequests)
          .where(eq(meetingRequests.meetingId, row.id));
      for (const removed of previous.filter(
        (x) => !plans.some((p) => p.requestId === x.requestId),
      ))
        await tx.insert(requestEvents).values({
          requestId: removed.requestId,
          kind: "workflow_stage",
          status: "received",
          body: "회의 연결이 해제되어 요청 접수 단계로 돌아갔습니다.",
          actorId: u.id,
        });
      if (old)
        await tx
          .update(requestWorkflowLinks)
          .set({ meetingId: null })
          .where(
            and(
              eq(requestWorkflowLinks.meetingId, old.id),
              sql`${requestWorkflowLinks.taskId} IS NULL`,
            ),
          );
      for (const plan of plans) {
        if (!previous.some((item) => item.requestId === plan.requestId)) {
          await recordRequestHandler(tx, plan.requestId, u, "meeting");
        }
        await tx
          .insert(requestWorkflowLinks)
          .values({ requestId: plan.requestId, meetingId: row.id })
          .onConflictDoUpdate({
            target: requestWorkflowLinks.requestId,
            set: { meetingId: row.id, approvalId: null },
          });
        await tx.insert(requestEvents).values({
          requestId: plan.requestId,
          kind: "workflow_stage",
          status: "review",
          body: "회의 검토 단계입니다.",
          actorId: u.id,
        });
      }
      for (const plan of plans) {
        let taskId: string | null = null;
        await tx
          .insert(meetingRequests)
          .values({ ...plan, meetingId: row.id, taskId });
      }
      return {
        meeting: {
          ...row,
          requests: await tx
            .select()
            .from(meetingRequests)
            .where(eq(meetingRequests.meetingId, row.id)),
        },
      };
    }, existingTx);
  }
  async listDocuments(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      await this.access(tx, u, pid, false, "documents.read");
      const rows = await tx
        .select({ document: documents, creatorName: users.displayName })
        .from(documents)
        .innerJoin(users, eq(users.id, documents.createdBy))
        .where(eq(documents.projectId, pid))
        .orderBy(desc(documents.updatedAt));
      return {
        documents: await Promise.all(
          rows.map(async (x) => ({
            ...x.document,
            creatorName: x.creatorName,
            versions: await tx
              .select({
                id: documentVersions.id,
                title: documentVersions.title,
                category: documentVersions.category,
                content: documentVersions.content,
                url: documentVersions.url,
                changeSummary: documentVersions.changeSummary,
                taskId: documentVersions.taskId,
                actorName: users.displayName,
                createdAt: documentVersions.createdAt,
              })
              .from(documentVersions)
              .innerJoin(users, eq(users.id, documentVersions.actorId))
              .where(eq(documentVersions.documentId, x.document.id))
              .orderBy(desc(documentVersions.createdAt)),
          })),
        ),
      };
    });
  }
  async saveDocument(
    u: User,
    pid: string,
    b: Record<string, unknown>,
    id?: string,
    existingTx?: Tx,
  ) {
    return this.run(async (tx) => {
      await this.access(
        tx,
        u,
        pid,
        true,
        id ? "documents.update" : "documents.create",
      );
      if (!b || typeof b !== "object" || Array.isArray(b))
        fail(400, "VALIDATION_ERROR", "변경 내용을 확인해주세요.");
      let old: typeof documents.$inferSelect | undefined;
      if (id) {
        [old] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, uuid(id)), eq(documents.projectId, pid)))
          .for("update");
        if (!old) fail(404, "NOT_FOUND", "문서를 찾을 수 없습니다.");
      }
      const taskId = b.taskId ? uuid(b.taskId) : null;
      if (taskId) {
        const [task] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.projectId, pid)));
        if (!task)
          fail(400, "INVALID_TASK", "같은 프로젝트의 업무를 연결해주세요.");
      }
      const changeSummary = bounded(
        b.changeSummary ?? (old ? "" : "최초 작성"),
        1000,
      );
      const values = {
        title: bounded(b?.title ?? old?.title, 160),
        category: choice(b?.category ?? old?.category ?? "other", [
          "plan",
          "design",
          "api",
          "meeting",
          "erd",
          "frontend",
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
      if (old) {
        const existing = await tx
          .select({ id: documentVersions.id })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, old.id))
          .limit(1);
        if (!existing.length)
          await tx.insert(documentVersions).values({
            documentId: old.id,
            title: old.title,
            category: old.category,
            content: old.content,
            url: old.url,
            changeSummary: "이력 도입 이전 버전",
            actorId: old.createdBy,
            createdAt: old.updatedAt,
          });
      }
      await tx.insert(documentVersions).values({
        documentId: row.id,
        ...values,
        changeSummary,
        taskId,
        actorId: u.id,
        createdAt: sql`clock_timestamp()`,
      });
      const [creator] = await tx
        .select({ name: users.displayName })
        .from(users)
        .where(eq(users.id, row.createdBy));
      return { document: { ...row, creatorName: creator.name } };
    }, existingTx);
  }
  async applyGitEvent(event: GitEvent) {
    if (!/^[a-f0-9]{40}$/i.test(event.commit))
      fail(400, "INVALID_COMMIT", "커밋을 확인해주세요.");
    const link = documentUrl(event.url);
    const rows = await this.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.repositoryUrl, event.repository));
    let updated = 0;
    const failed: { taskId: string; code: string }[] = [];
    for (const task of rows) {
      if (task.stageKey) continue;
      if (task.liveBranch !== event.branch) continue;
      if (
        event.kind === "merge" &&
        (task.workBranch !== event.workBranch || task.status !== "in_progress")
      )
        continue;
      if (
        event.kind === "deployment" &&
        (![event.commit, ...(event.includedCommits ?? [])].includes(
          task.mergeCommit,
        ) ||
          task.status !== "done")
      )
        continue;
      if (!task.resultSummary.trim()) continue;
      const [member] = await this.database.db
        .select({
          id: users.id,
          displayName: users.displayName,
          accountType: users.accountType,
        })
        .from(taskAssignees)
        .innerJoin(users, eq(users.id, taskAssignees.userId))
        .where(
          and(
            eq(taskAssignees.taskId, task.id),
            eq(users.accountType, "team"),
            eq(users.status, "active"),
          ),
        );
      if (!member) continue;
      try {
        const result = await this.saveTask(
          member,
          task.projectId,
          event.kind === "merge"
            ? {
                status: "done",
                mergeCommit: event.commit,
                pullRequestUrl: link,
              }
            : { status: "released", deploymentUrl: link },
          task.id,
          event,
        );
        if (!result.ignored) updated++;
      } catch (error) {
        // A rejected task must not block other tasks; infrastructure failures still trigger webhook retry.
        const status = (error as { getStatus?: () => number }).getStatus?.();
        if (status && status >= 400 && status < 500) {
          const response = (
            error as { getResponse?: () => unknown }
          ).getResponse?.();
          const code =
            response && typeof response === "object" && "code" in response
              ? String(response.code)
              : "TASK_SYNC_REJECTED";
          failed.push({ taskId: task.id, code });
          await this.database.db.transaction((tx) =>
            this.event(
              tx,
              member,
              task.projectId,
              task.id,
              "git_sync_failed",
              `Git 상태 반영 실패: ${code}. 업무 상태와 승인 정보를 확인해주세요.`,
            ),
          );
          continue;
        }
        throw error;
      }
    }
    return { updated, failed };
  }
  private async syncRequests(
    tx: Tx,
    u: User,
    pid: string,
    requestIds: string[],
  ) {
    for (const rid of requestIds) {
      const linked = await tx
        .select({
          status: tasks.status,
          stageKey: tasks.stageKey,
          completionMode: tasks.completionMode,
        })
        .from(taskRequests)
        .innerJoin(tasks, eq(tasks.id, taskRequests.taskId))
        .where(eq(taskRequests.requestId, rid));
      const stage = customerWorkflowStage(linked);
      const status =
        stage === "completed"
          ? "completed"
          : stage === "in_progress"
            ? "in_progress"
            : "received";
      const [request] = await tx
        .select()
        .from(projectRequests)
        .where(
          and(eq(projectRequests.id, rid), eq(projectRequests.projectId, pid)),
        );
      if (request && request.status !== status) {
        await tx
          .update(projectRequests)
          .set({ status, updatedAt: sql`clock_timestamp()` })
          .where(eq(projectRequests.id, rid));
        await tx.insert(requestEvents).values({
          requestId: rid,
          actorId: u.id,
          kind: "status",
          status,
          body: "연결된 개발 업무의 진행 상태 반영",
        });
      }
    }
  }
  async listActivity(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.access(tx, u, pid, false, "activity.read");
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
      const requests = !access.permissions.includes("requests.read")
        ? []
        : await tx
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
          ...events.filter((e) => {
            if (e.kind === "request_transferred")
              return (
                access.permissions.includes("meetings.read") &&
                access.permissions.includes("requests.read")
              );
            if (e.kind.startsWith("task_"))
              return access.permissions.includes("tasks.read");
            if (e.kind.startsWith("meeting_"))
              return access.permissions.includes("meetings.read");
            if (e.kind.startsWith("document_"))
              return access.permissions.includes("documents.read");
            // New event types require an explicit visibility mapping before exposure.
            return false;
          }),
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
