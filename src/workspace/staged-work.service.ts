import { recordTaskActivity } from "./activity-record.js";
import { GithubConnectionService } from "./github-connection.service.js";
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
    private readonly githubConnection?: GithubConnectionService,
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
    const kind=({completed:task.completionMode==="test"?"qa_completed":"task_completed",approved:"task_approved",changes_requested:"task_changes_requested",invalidated:"task_invalidated",merged:"deploy_ready",deploy_started:"deploy_started",released:"deploy_completed",deploy_failed:"deploy_failed"} as Record<string,string>)[action] ?? "task_invalidated";
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
      task.mergeCommit || children.some((child) => !!child.mergeCommit || ["deploying", "released"].includes(child.status))
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
          status: child.status === "todo" ? "todo" : "in_progress",
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
        "선행 업무가 변경되었습니다. 변경 내용을 확인하고 작업을 계속해주세요. 기존 완료·승인은 초기화되었습니다.",
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
  private async predecessors(tx: Tx, task: Task, u?: User) {
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
        const { pr } = await this.currentPr(predecessor, true, u);
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
  private async taskGithub<T>(task: Task, u: User | undefined, path: string, body?: object, method = body ? "PUT" : "GET"): Promise<T> {
    const [project] = await this.database.db.select().from(projects).where(eq(projects.id, task.projectId));
    if (!task.repositoryUrl || !project?.repositoryUrls.includes(task.repositoryUrl))
      fail(403, "REPOSITORY_DENIED", "프로젝트 저장소를 확인해주세요.");
    const prefix = `/repos/${task.repositoryUrl!.slice("https://github.com/".length)}`;
    if (!path.startsWith(prefix + "/")) fail(400, "INVALID_PR", "PR 경로를 확인해주세요.");
    const suffix = path.slice(prefix.length);
    // Use the authenticated actor's GitHub grant for both submission and approval.
    // Never borrow another member's token or silently fall back to server credentials.
    if (!u || !this.githubConnection || !(await this.githubConnection.status(u.id)).connected)
      fail(409, "GITHUB_CONNECT_REQUIRED", "업무 화면의 내 GitHub 계정 연결에서 본인 계정을 연결해주세요. PR 요청은 담당자, 승인·머지는 승인자의 GitHub 권한으로 처리합니다.");
    return this.githubConnection!.repositoryRequest(u!.id, task.repositoryUrl!, suffix, method, body);
  }
  private async currentPr(task: Task, allowMerged = false, u?: User) {
    if (task.liveBranch !== "main")
      fail(409, "MAIN_REQUIRED", "배포 대상 브랜치는 main이어야 합니다.");
    const path = pullRequestPath(
      task.projectId,
      task.repositoryUrl,
      task.pullRequestUrl,
      [task.repositoryUrl!],
    );
    const pr = await this.taskGithub<PullRequest>(task, u, path);
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
  async gitContext(u: User, pid: string, id: string, write = false) {
    return this.database.db.transaction(async tx => {
      const task = await this.task(tx, u, pid, id, write ? "tasks.progress" : "tasks.read");
      const [project] = await tx.select().from(projects).where(eq(projects.id, pid));
      if (write) {
        const [mine] = await tx.select().from(taskAssignees).where(and(eq(taskAssignees.taskId, id), eq(taskAssignees.userId, u.id)));
        if (!mine || mine.completedAt || !["todo", "in_progress"].includes(task.status) || task.completionMode !== "code")
          fail(403, "TASK_NOT_EDITABLE", "진행 가능한 코드 업무의 미완료 담당자만 작업할 수 있습니다.");
      }
      return { task, repositoryUrls: project?.repositoryUrls || [] };
    });
  }
  async submitPr(u: User, pid: string, id: string, b: Record<string, unknown>) {
    if (!/^[a-f0-9]{40}$/i.test(String(b.headSha || ""))) fail(400, "INVALID_SHA", "로컬 커밋을 확인해주세요.");
    const result = await this.database.db.transaction(async tx => {
      const task = await this.task(tx, u, pid, id, "tasks.progress");
      const [mine] = await tx.select().from(taskAssignees).where(and(eq(taskAssignees.taskId, id), eq(taskAssignees.userId, u.id)));
      const [project] = await tx.select().from(projects).where(eq(projects.id, pid));
      if (!mine || mine.completedAt || !["todo", "in_progress"].includes(task.status) || task.completionMode !== "code")
        fail(403, "TASK_NOT_EDITABLE", "진행 중인 코드 업무의 미완료 담당자만 제출할 수 있습니다.");
      if (b.expectedRevision !== task.workRevision) fail(409, "STALE_REVISION", "업무가 변경되었습니다. 다시 확인해주세요.");
      if (!task.repositoryUrl || !project?.repositoryUrls.includes(task.repositoryUrl) || !task.workBranch || task.workBranch === task.liveBranch || task.liveBranch !== "main")
        fail(409, "BRANCH_REQUIRED", "프로젝트 저장소의 업무 브랜치를 먼저 연결해주세요.");
      const request = (suffix: string, method = "GET", body?: object) => this.taskGithub<any>(task, u, `/repos/${task.repositoryUrl!.slice("https://github.com/".length)}${suffix}`, body, method);
      const ref = await request(`/git/ref/heads/${encodeURIComponent(task.workBranch)}`);
      if (ref.object?.sha !== b.headSha) fail(409, "REMOTE_CHANGED", "로컬과 원격 커밋이 다릅니다. 동기화 후 제출해주세요.");
      const query = `/pulls?state=open&head=${encodeURIComponent(task.repositoryUrl!.split("/")[3] + ":" + task.workBranch)}&base=${encodeURIComponent(task.liveBranch)}`;
      let pr: PullRequest;
      if (task.pullRequestUrl) {
        const path = pullRequestPath(pid, task.repositoryUrl, task.pullRequestUrl, project.repositoryUrls);
        pr = await request(path.slice(`/repos/${task.repositoryUrl!.slice("https://github.com/".length)}`.length));
      } else {
        const found = await request(query);
        pr = found[0];
        if (!pr) {
          try { pr = await request("/pulls", "POST", { title: task.title, head: task.workBranch, base: task.liveBranch, body: `Bridgain 업무: ${task.id}` }); }
          catch (error) { const retry = await request(query); if (!retry[0]) throw error; pr = retry[0]; }
        }
      }
      checkPullRequest(pr, { ...task, pullRequestUrl: pr.html_url });
      if (pr.head.sha !== b.headSha) fail(409, "REMOTE_CHANGED", "PR 커밋이 변경되었습니다. 다시 확인해주세요.");
      await this.uniquePr(tx, { ...task, pullRequestUrl: pr.html_url });
      await tx.update(tasks).set({ pullRequestUrl: pr.html_url, version: randomUUID(), updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, id));
      return { pullRequestUrl: pr.html_url, revision: task.workRevision };
    });
    // PR survives a failed completion request. Retrying reuses the same open PR.
    const work = await this.act(u, pid, id, { action: "complete", expectedRevision: result.revision, expectedHeadSha: b.headSha });
    if ("stale" in work && work.stale) fail(409, "PR_CHANGED", "PR 코드 변경으로 이전 완료·승인을 초기화했습니다. 최신 업무에서 다시 제출해주세요.");
    return { ...result, work };
  }
  async remoteCode(u: User, pid: string, id: string) {
    const { task, repositoryUrls } = await this.gitContext(u, pid, id);
    if (!task.repositoryUrl || !task.pullRequestUrl || !repositoryUrls.includes(task.repositoryUrl))
      fail(409, "PR_REQUIRED", "연결된 PR이 없습니다.");
    const { path, pr } = await this.currentPr(task, true, u);
    const files: any[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.taskGithub<any[]>(task, u, `${path}/files?per_page=100&page=${page}`);
      files.push(...batch.map(f => ({ path: f.filename, status: f.status, diff: String(f.patch || "바이너리 또는 큰 파일: GitHub에서 확인해주세요.").slice(0, 256000) })));
      if (batch.length < 100) break;
    }
    return { headSha: pr.head.sha, approvedHeadSha: task.approvedHeadSha, pullRequestUrl: pr.html_url, files, limited: files.length >= 300 };
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
      if (action === "approve" || action === "complete") await this.predecessors(tx, task, u);
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
      if (task.mergeCommit) {
        if (action === "approve" || action === "refresh")
          return { status: task.status, mergeCommit: task.mergeCommit };
        fail(409, "NEW_REQUEST_REQUIRED", "이미 main에 병합된 업무입니다. 변경은 새 업무로 등록해주세요.");
      }
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
        const { pr } = await this.currentPr(task, action === "approve", u);
        if (action === "complete" && b.expectedHeadSha && b.expectedHeadSha !== pr.head.sha)
          fail(409, "REMOTE_CHANGED", "제출 중 PR 커밋이 변경되었습니다. 다시 확인해주세요.");
        head = pr.head.sha;
        const reviewedHead = task.reviewHeadSha || task.approvedHeadSha;
        if (reviewedHead && reviewedHead !== head) {
          await this.reset(
            tx,
            task,
            u.id,
            "PR 코드가 변경되어 재승인이 필요합니다.",
          );
          return { status: "in_progress", stale: true };
        }
        if (action === "approve" && b.expectedHeadSha !== head)
          fail(409, "REMOTE_CHANGED", "검토한 PR 커밋과 현재 코드가 다릅니다. 최신 변경 코드를 확인한 뒤 승인해주세요.");
      }
      if (action === "refresh") return { status: task.status };
      if (action === "complete") {
        if (!["todo", "in_progress"].includes(task.status))
          fail(409, "INVALID_TRANSITION", "진행 중 업무만 완료할 수 있습니다.");
        if (!assigned.some((a) => a.userId === u.id))
          fail(403, "ASSIGNEE_REQUIRED", "담당자만 완료할 수 있습니다.");
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
      const legacyUnmerged = task.completionMode === "code" && task.status === "deploy_pending" && !task.mergeCommit;
      if (task.status !== "review_pending" && !legacyUnmerged)
        fail(
          409,
          "INVALID_TRANSITION",
          "모든 담당자가 완료한 뒤 승인할 수 있습니다.",
        );
      if (!assigned.length || assigned.some((a) => !a.completedAt))
        fail(409, "COMPLETION_REQUIRED", "모든 담당자의 완료가 필요합니다.");
      const retryMerge = task.completionMode === "code" && votes.every((v) => v.status === "approved");
      if (votes.find((v) => v.userId === u.id)?.status === "approved" && !retryMerge)
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
      if (!retryMerge) await this.record(tx, task, u.id, "approved", note, head);
      if (all && task.completionMode === "code")
        return this.mergeApproved(tx, u, { ...task, status, approvedHeadSha: head });
      return { status };
    });
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
              sql`${tasks.mergeCommit} <> ''`,
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
    return this.database.db.transaction(async (tx) => {
      const task = await this.task(tx, u, pid, id, "deploy.run");
      if (["released", "deploying"].includes(task.status)) return { status: task.status };
      if (task.status !== "deploy_pending" || !/^[a-f0-9]{40}$/i.test(task.mergeCommit ?? ""))
        fail(409, "MERGE_REQUIRED", "업무 승인 화면에서 main 병합을 완료한 뒤 배포를 시작해주세요.");
      await this.predecessors(tx, task, u);
      await tx.update(tasks).set({ status: "deploying", version: randomUUID(), updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, id));
      await this.record(tx, task, u.id, "deploy_started", "", task.approvedHeadSha);
      return { status: "deploying" };
    });
  }
  private async mergeApproved(tx: Tx, u: User, task: Task) {
    const { path, pr } = await this.currentPr(task, true, u);
    if (task.approvedHeadSha !== pr.head.sha) {
      await this.reset(tx, task, u.id, "병합 전 PR 코드 변경 확인: 재승인이 필요합니다.");
      return { status: "in_progress", stale: true };
    }
    const codeAncestors = (await this.ancestorTasks(tx, task)).filter(t => t.completionMode === "code");
    if (codeAncestors.some(t => !t.mergeCommit))
      fail(409, "PREDECESSOR_MERGE_REQUIRED", "선행 코드 업무의 main 병합을 먼저 완료해주세요.");
    const [attempt] = await tx.insert(attempts).values({ taskId: task.id, actorId: u.id, status: "pending", headSha: pr.head.sha }).returning();
    let merged: { merged: boolean; sha: string | null };
    try {
      if ((pr as PullRequest & { mergeable?: boolean }).mergeable === false && !pr.merged)
        fail(409, "MERGE_CONFLICT", "병합 충돌을 해결하거나 재작업을 요청한 뒤 다시 시도해주세요.");
      merged = pr.merged
        ? { merged: true, sha: pr.merge_commit_sha }
        : await this.taskGithub<{ merged: boolean; sha: string }>(task, u, `${path}/merge`, { sha: pr.head.sha, merge_method: "merge" });
      if (!merged.merged || !/^[a-f0-9]{40}$/i.test(merged.sha ?? ""))
        fail(409, "MERGE_REJECTED", "병합하지 못했습니다. 충돌·필수 검사·연동 권한을 확인한 뒤 다시 시도해주세요.");
    } catch (e: any) {
      const error = String(e?.response?.message ?? "GitHub 병합 결과를 확인하지 못했습니다. 다시 시도하면 기존 병합 여부부터 확인합니다.").slice(0, 5000);
      await tx.update(tasks).set({ status: "review_pending", approvedHeadSha: task.approvedHeadSha, version: randomUUID(), updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, task.id));
      await tx.update(attempts).set({ status: "failed", note: error, updatedAt: sql`clock_timestamp()` }).where(eq(attempts.id, attempt.id));
      await recordTaskActivity(tx, task.id, u.id, "deploy_failed", error, `attempt:${attempt.id}:failed`);
      return { status: "review_pending", mergeFailed: true, error };
    }
    // SQL failures must roll back rather than hide a successful external merge. Retry reads pr.merged.
    await tx.update(tasks).set({ status: "deploy_pending", mergeCommit: merged.sha!, approvedHeadSha: task.approvedHeadSha, version: randomUUID(), updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, task.id));
    await tx.update(attempts).set({ status: "merged", updatedAt: sql`clock_timestamp()` }).where(eq(attempts.id, attempt.id));
    await this.record(tx, task, u.id, "merged", "승인된 PR이 main에 병합되어 배포 대기 중입니다.", pr.head.sha);
    return { status: "deploy_pending", mergeCommit: merged.sha! };
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
        !!t.mergeCommit ||
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
          !current.mergeCommit &&
          !["deploying", "released"].includes(current.status) &&
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
      .where(eq(tasks.repositoryUrl, event.repository));
    let updated = 0;
    for (const task of linked) {
      if (!task.stageKey) continue;
      const applied = await this.database.db.transaction(async (tx) => {
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
          !["deploy_pending", "deploying"].includes(current.status) ||
          current.repositoryUrl !== event.repository ||
          current.liveBranch !== event.branch ||
          !current.mergeCommit ||
          ![event.commit, ...(event.includedCommits ?? [])].includes(current.mergeCommit)
        )
          return false;
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
        return true;
      });
      if (applied) updated++;
    }
    return { updated };
  }
}
