import { Injectable } from "@nestjs/common";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { users } from "../db/schema/auth.js";
import {
  projects,
  projectMemberships as pm,
  teamMemberships as tm,
} from "../db/schema/workspace.js";
import { projectRequests, requestEvents } from "../db/schema/requests.js";
import {
  taskApprovals as approvals,
  taskApprovalReviewers as reviewers,
  requestWorkflowLinks as links,
  meetingRequests,
  projectMeetings,
  projectTasks,
  taskRequests,
  taskAssignees,
  type ApprovalPlan,
} from "../db/schema/project-work.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { ids, choice } from "./project-work.service.js";
import { uuid, bounded } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
@Injectable()
export class ApprovalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  async eligible(tx: Tx, pid: string) {
    const rows = await tx
      .select({
        userId: users.id,
        displayName: users.displayName,
        canApproveTasks: pm.canApproveTasks,
        role: tm.permissionRole,
        accessRole: pm.accessRole,
      })
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
          eq(users.accountType, "team"),
          eq(users.status, "active"),
        ),
      );
    const eligible = [];
    for (const x of rows) {
      if (
        x.accessRole !== "client" &&
        (
          await this.requests.access(
            tx,
            { id: x.userId, displayName: x.displayName, accountType: "team" },
            pid,
          )
        ).canApproveTasks
      )
        eligible.push(x);
    }
    return eligible;
  }

  private async output(tx: Tx, a: typeof approvals.$inferSelect, u: User) {
    const approvers = await tx
      .select({
        userId: reviewers.userId,
        displayName: users.displayName,
        status: reviewers.status,
        actedAt: reviewers.actedAt,
        note: reviewers.note,
      })
      .from(reviewers)
      .innerJoin(users, eq(users.id, reviewers.userId))
      .where(eq(reviewers.approvalId, a.id));
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, a.projectId));
    const [requester] = await tx
      .select()
      .from(users)
      .where(eq(users.id, a.requestedBy));
    const requests = await tx
      .select()
      .from(projectRequests)
      .where(
        inArray(
          projectRequests.id,
          a.plans.map((p) => p.requestId),
        ),
      );
    const eligible = await this.eligible(tx, a.projectId);
    return {
      ...a,
      projectName: project.name,
      requesterName: requester.displayName,
      plans: a.plans.map((p) => ({
        ...p,
        title: requests.find((r) => r.id === p.requestId)?.title,
        origin: requests.find((r) => r.id === p.requestId)?.origin,
      })),
      approvers,
      canApprove:
        a.status === "pending" &&
        eligible.some((x) => x.userId === u.id) &&
        approvers.some((x) => x.userId === u.id && x.status === "pending"),
      canCancel:
        a.status === "pending" &&
        (a.requestedBy === u.id ||
          (await this.requests.access(tx, u, a.projectId)).canAssign),
    };
  }
  async list(u: User, pid?: string) {
    return this.database.db.transaction(async (tx) => {
      if (u.accountType !== "team")
        fail(403, "FORBIDDEN", "개발팀만 접근할 수 있습니다.");
      if (pid) {
        const p = await this.requests.access(tx, u, pid);
        if (
          !p.isDeveloper ||
          (!p.permissions.includes("requests.read") && !p.canApproveTasks)
        )
          fail(403, "FORBIDDEN", "승인 내역을 조회할 권한이 없습니다.");
      }
      const memberships = await tx.select().from(pm).where(eq(pm.userId, u.id));
      const projectIds = pid
        ? [pid]
        : memberships
            .filter((x) => x.accessRole !== "client")
            .map((x) => x.projectId);
      const rows = projectIds.length
        ? await tx
            .select()
            .from(approvals)
            .where(inArray(approvals.projectId, projectIds))
            .orderBy(desc(approvals.createdAt))
        : [];
      const visible = [];
      for (const row of rows) {
        const access = await this.requests.access(tx, u, row.projectId);
        if (
          access.isDeveloper &&
          (access.permissions.includes("requests.read") ||
            access.canApproveTasks)
        )
          visible.push(row);
      }
      const out = await Promise.all(visible.map((a) => this.output(tx, a, u)));
      return {
        approvals: out,
        canApproveTasks: (
          await Promise.all(projectIds.map((id) => this.eligible(tx, id)))
        )
          .flat()
          .some((x) => x.userId === u.id),
        pendingCount: out.filter((a) => a.canApprove).length,
        ...(pid
          ? {
              approvers: await this.eligible(tx, pid),
              canApproveTasks: (await this.eligible(tx, pid)).some(
                (x) => x.userId === u.id,
              ),
            }
          : {}),
      };
    });
  }
  async create(u: User, pid: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      const p = await this.requests.access(tx, u, pid, true);
      if (!p.isDeveloper)
        fail(403, "FORBIDDEN", "개발팀만 승인 요청할 수 있습니다.");
      // Submission freezes assignees into the executable approval plan.
      // Legacy members retain the existing proposal flow until roles are configured.
      if (p.rolesConfigured) requireProjectPermission(p, "tasks.assign");
      const source = choice(b.source, ["meeting", "urgent"]);
      requireProjectPermission(
        p,
        source === "meeting" ? "meetings.update" : "requests.create",
      );
      requireProjectPermission(p, "requests.read");
      const approverIds = ids(b.approverIds);
      if (!approverIds.length)
        fail(400, "APPROVER_REQUIRED", "필수 승인자를 선택해주세요.");
      const eligible = await this.eligible(tx, pid);
      if (approverIds.some((id) => !eligible.some((x) => x.userId === id)))
        fail(400, "INVALID_APPROVER", "프로젝트 승인권자를 선택해주세요.");
      let meetingId: string | null = null;
      let title = "긴급 업무 승인";
      let raw = b.plans;
      if (source === "meeting") {
        meetingId = uuid(b.meetingId);
        const [m] = await tx
          .select()
          .from(projectMeetings)
          .where(
            and(
              eq(projectMeetings.id, meetingId),
              eq(projectMeetings.projectId, pid),
            ),
          )
          .for("update");
        if (!m) fail(404, "NOT_FOUND", "회의를 찾을 수 없습니다.");
        if (m.decisionStatus === "final")
          fail(409, "MEETING_FINAL", "이미 승인된 회의입니다.");
        title = m.title;
        raw = await tx
          .select()
          .from(meetingRequests)
          .where(eq(meetingRequests.meetingId, meetingId));
        if (b.plans !== undefined) raw = b.plans;
      }
      if (!Array.isArray(raw) || !raw.length || raw.length > 50)
        fail(400, "PLAN_REQUIRED", "요청별 기획과 담당자를 입력해주세요.");
      const plans: ApprovalPlan[] = (raw as Record<string, unknown>[]).map(
        (x) => ({
          requestId: uuid(x.requestId).toLowerCase(),
          planning: bounded(x.planning, 10000),
          uiNotes: bounded(x.uiNotes ?? "", 10000, false),
          apiNotes: bounded(x.apiNotes ?? "", 10000, false),
          dbNotes: bounded(x.dbNotes ?? "", 10000, false),
          priority: choice(x.priority ?? "normal", [
            "urgent",
            "high",
            "normal",
            "low",
          ]),
          assigneeIds: ids(x.assigneeIds),
        }),
      );
      if (new Set(plans.map((x) => x.requestId)).size !== plans.length)
        fail(400, "DUPLICATE_REQUEST", "요청을 중복 연결할 수 없습니다.");
      const members = await tx
        .select({ id: users.id, role: pm.accessRole })
        .from(pm)
        .innerJoin(users, eq(users.id, pm.userId))
        .innerJoin(projects, eq(projects.id, pm.projectId))
        .innerJoin(
          tm,
          and(eq(tm.teamId, projects.teamId), eq(tm.userId, users.id)),
        )
        .where(
          and(
            eq(pm.projectId, pid),
            eq(users.accountType, "team"),
            eq(users.status, "active"),
          ),
        );
      for (const plan of plans) {
        for (const id of plan.assigneeIds) {
          const memberAccess = await this.requests.access(
            tx,
            { id, displayName: "", accountType: "team" },
            pid,
          );
          if (!memberAccess.permissions.includes("tasks.progress"))
            fail(
              400,
              "INVALID_ASSIGNEE",
              "업무 진행 권한이 있는 담당자를 지정해주세요.",
            );
        }
        if (
          !plan.assigneeIds.length ||
          plan.assigneeIds.some(
            (id) => !members.some((m) => m.id === id && m.role !== "client"),
          )
        )
          fail(400, "INVALID_ASSIGNEE", "개발팀 담당자를 지정해주세요.");
        const [r] = await tx
          .select()
          .from(projectRequests)
          .where(
            and(
              eq(projectRequests.id, plan.requestId),
              eq(projectRequests.projectId, pid),
            ),
          )
          .for("update");
        if (!r) fail(404, "NOT_FOUND", "요청을 찾을 수 없습니다.");
        const [l] = await tx
          .select()
          .from(links)
          .where(eq(links.requestId, r.id));
        const tasks = await tx
          .select()
          .from(taskRequests)
          .where(eq(taskRequests.requestId, r.id));
        if (l?.taskId || tasks.length)
          fail(409, "REQUEST_TASK_LINKED", "이미 업무화된 요청입니다.");
        if (l?.approvalId) {
          const [a] = await tx
            .select()
            .from(approvals)
            .where(eq(approvals.id, l.approvalId));
          if (a?.status === "pending" || a?.status === "approved")
            fail(
              409,
              "APPROVAL_PENDING",
              "기존 승인 요청을 먼저 취소해주세요.",
            );
        }
        if (l?.meetingId && l.meetingId !== meetingId)
          fail(
            409,
            "REQUEST_MEETING_LINKED",
            "기존 회의에서 요청을 먼저 이동하거나 제외해주세요.",
          );
        if (meetingId) {
          const rows = await tx
            .select()
            .from(meetingRequests)
            .where(
              and(
                eq(meetingRequests.meetingId, meetingId),
                eq(meetingRequests.requestId, r.id),
              ),
            );
          if (!rows.length)
            fail(
              409,
              "MEETING_CHANGED",
              "회의에 연결된 요청만 승인할 수 있습니다.",
            );
        }
      }
      if (meetingId) {
        const rows = await tx
          .select()
          .from(meetingRequests)
          .where(eq(meetingRequests.meetingId, meetingId));
        if (rows.length !== plans.length)
          fail(409, "MEETING_CHANGED", "회의의 모든 요청을 함께 승인해주세요.");
      }
      const [a] = await tx
        .insert(approvals)
        .values({
          projectId: pid,
          source,
          meetingId,
          title,
          plans,
          requestedBy: u.id,
        })
        .returning();
      await tx
        .insert(reviewers)
        .values(approverIds.map((userId) => ({ approvalId: a.id, userId })));
      for (const plan of plans) {
        await tx
          .insert(links)
          .values({ requestId: plan.requestId, meetingId, approvalId: a.id })
          .onConflictDoUpdate({
            target: links.requestId,
            set: { meetingId, approvalId: a.id },
          });
        await tx.insert(requestEvents).values({
          requestId: plan.requestId,
          kind: "workflow_stage",
          status: "review",
          body: "업무화 승인을 요청했습니다.",
          actorId: u.id,
        });
      }
      return { approval: await this.output(tx, a, u) };
    });
  }
  async act(u: User, pid: string, id: string, b: Record<string, unknown>) {
    return this.database.db.transaction(async (tx) => {
      const p = await this.requests.access(tx, u, pid, true);
      if (!p.isDeveloper)
        fail(403, "FORBIDDEN", "개발팀만 접근할 수 있습니다.");
      const [a] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, uuid(id)), eq(approvals.projectId, pid)))
        .for("update");
      if (!a) fail(404, "NOT_FOUND", "승인 요청을 찾을 수 없습니다.");
      if (a.status !== "pending")
        fail(409, "APPROVAL_CLOSED", "이미 처리된 승인 요청입니다.");
      const action = choice(b.action, ["approve", "reject", "cancel"]);
      const note = bounded(b.note ?? "", 2000, false);
      if (action === "cancel") {
        if (a.requestedBy !== u.id && !p.canAssign)
          fail(403, "FORBIDDEN", "요청자와 관리자만 취소할 수 있습니다.");
      } else {
        const eligible = await this.eligible(tx, pid);
        const [r] = await tx
          .select()
          .from(reviewers)
          .where(and(eq(reviewers.approvalId, id), eq(reviewers.userId, u.id)));
        if (
          !eligible.some((x) => x.userId === u.id) ||
          !r ||
          r.status !== "pending"
        )
          fail(403, "FORBIDDEN", "지정된 대기 승인자만 처리할 수 있습니다.");
        if (action === "reject" && !note.trim())
          fail(400, "NOTE_REQUIRED", "반려 사유를 입력해주세요.");
        await tx
          .update(reviewers)
          .set({
            status: action === "approve" ? "approved" : "rejected",
            note,
            actedAt: new Date(),
          })
          .where(and(eq(reviewers.approvalId, id), eq(reviewers.userId, u.id)));
      }
      let status =
        action === "cancel"
          ? "cancelled"
          : action === "reject"
            ? "rejected"
            : "pending";
      if (action === "approve") {
        const rs = await tx
          .select()
          .from(reviewers)
          .where(eq(reviewers.approvalId, id));
        if (rs.every((r) => r.status === "approved")) status = "approved";
      }
      if (status === "approved") {
        const eligible = await this.eligible(tx, pid);
        const required = await tx
          .select()
          .from(reviewers)
          .where(eq(reviewers.approvalId, id));
        if (required.some((r) => !eligible.some((e) => e.userId === r.userId)))
          fail(
            409,
            "APPROVER_CHANGED",
            "승인권한이 변경되었습니다. 취소 후 승인자를 다시 지정해주세요.",
          );
        const active = await tx
          .select({ id: users.id, role: pm.accessRole })
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
              eq(users.accountType, "team"),
              eq(users.status, "active"),
            ),
          );
        if (
          a.plans.some((p) =>
            p.assigneeIds.some(
              (id) => !active.some((m) => m.id === id && m.role !== "client"),
            ),
          )
        )
          fail(
            409,
            "ASSIGNEE_CHANGED",
            "담당자 참여 상태가 변경되었습니다. 취소 후 다시 요청해주세요.",
          );

        for (const plan of a.plans) {
          for (const id of plan.assigneeIds) {
            const memberAccess = await this.requests.access(
              tx,
              { id, displayName: "", accountType: "team" },
              pid,
            );
            if (!memberAccess.permissions.includes("tasks.progress"))
              fail(
                409,
                "ASSIGNEE_CHANGED",
                "담당자의 업무 진행 권한이 변경되었습니다.",
              );
          }
          const [request] = await tx
            .select()
            .from(projectRequests)
            .where(eq(projectRequests.id, plan.requestId))
            .for("update");
          const existing = await tx
            .select()
            .from(taskRequests)
            .where(eq(taskRequests.requestId, plan.requestId));
          if (existing.length)
            fail(409, "REQUEST_TASK_LINKED", "이미 업무화된 요청입니다.");
          const [task] = await tx
            .insert(projectTasks)
            .values({
              projectId: pid,
              title: request.title,
              description: [
                plan.planning,
                plan.uiNotes && `UI: ${plan.uiNotes}`,
                plan.apiNotes && `API: ${plan.apiNotes}`,
                plan.dbNotes && `DB: ${plan.dbNotes}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              priority: plan.priority,
              createdBy: a.requestedBy,
              approvalId: a.id,
            })
            .returning();
          await tx
            .insert(taskRequests)
            .values({ taskId: task.id, requestId: plan.requestId });
          await tx
            .insert(taskAssignees)
            .values(
              plan.assigneeIds.map((userId) => ({ taskId: task.id, userId })),
            );
          await tx
            .update(links)
            .set({ taskId: task.id })
            .where(eq(links.requestId, plan.requestId));
          if (a.meetingId)
            await tx
              .update(meetingRequests)
              .set({ taskId: task.id, ...plan })
              .where(
                and(
                  eq(meetingRequests.meetingId, a.meetingId),
                  eq(meetingRequests.requestId, plan.requestId),
                ),
              );
          await tx.insert(requestEvents).values({
            requestId: plan.requestId,
            kind: "workflow_stage",
            status: "in_progress",
            body: "필수 승인자 전원이 승인하여 업무가 생성되었습니다.",
            actorId: u.id,
          });
        }
        if (a.meetingId)
          await tx
            .update(projectMeetings)
            .set({ decisionStatus: "final", updatedAt: new Date() })
            .where(eq(projectMeetings.id, a.meetingId));
      }
      if (status === "cancelled" || status === "rejected") {
        await tx
          .update(links)
          .set({ approvalId: null })
          .where(eq(links.approvalId, id));
        if (!a.meetingId)
          for (const plan of a.plans)
            await tx.insert(requestEvents).values({
              requestId: plan.requestId,
              kind: "workflow_stage",
              status: "received",
              body: "승인 절차가 종료되어 요청 접수 단계로 돌아갔습니다.",
              actorId: u.id,
            });
      }
      const [updated] = await tx
        .update(approvals)
        .set({ status, updatedAt: new Date() })
        .where(eq(approvals.id, id))
        .returning();
      return { approval: await this.output(tx, updated, u) };
    });
  }
  async delegate(
    u: User,
    pid: string,
    userId: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const p = await this.requests.access(tx, u, pid, true);
      requireProjectPermission(p, "roles.manage");
      if (p.rolesConfigured)
        fail(
          409,
          "ROLES_MANAGED",
          "역할·권한 설정에서 승인 권한을 변경해주세요.",
        );
      if (typeof b.canApproveTasks !== "boolean")
        fail(400, "VALIDATION_ERROR", "승인권한을 확인해주세요.");
      const [m] = await tx
        .select({ role: pm.accessRole, accountType: users.accountType })
        .from(pm)
        .innerJoin(users, eq(users.id, pm.userId))
        .where(and(eq(pm.projectId, pid), eq(pm.userId, uuid(userId))));
      if (!m || m.role === "client" || m.accountType !== "team")
        fail(
          400,
          "INVALID_APPROVER",
          "개발팀 참여자에게만 위임할 수 있습니다.",
        );
      await tx
        .update(pm)
        .set({ canApproveTasks: b.canApproveTasks as boolean })
        .where(and(eq(pm.projectId, pid), eq(pm.userId, userId)));
      return { userId, canApproveTasks: b.canApproveTasks };
    });
  }
}
