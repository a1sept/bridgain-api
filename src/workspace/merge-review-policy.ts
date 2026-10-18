import { resolveProjectPermissions } from "./project-roles.service.js";
import { and, eq } from "drizzle-orm";
import { fail } from "../auth/security.js";
import { users } from "../db/schema/auth.js";
import {
  projects,
  projectMemberships as pm,
  teamMemberships as tm,
} from "../db/schema/workspace.js";
import type { DatabaseService } from "../db/database.service.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export async function requireMergeReviewer(
  tx: Tx,
  pid: string,
  reviewerId: string | null,
  assigneeIds: string[],
  requesterId?: string | null,
) {
  if (
    !reviewerId ||
    assigneeIds.includes(reviewerId) ||
    requesterId === reviewerId
  )
    fail(
      409,
      "INVALID_REVIEWER",
      "담당자·검토 요청자와 다른 병합 승인자를 지정해주세요.",
    );
  const [reviewer] = await tx
    .select({
      id: users.id,
      role: pm.accessRole,
      accountType: users.accountType,
      status: users.status,
      allowed: tm.canApproveMerge,
    })
    .from(pm)
    .innerJoin(projects, eq(projects.id, pm.projectId))
    .innerJoin(
      tm,
      and(eq(tm.teamId, projects.teamId), eq(tm.userId, pm.userId)),
    )
    .innerJoin(users, eq(users.id, pm.userId))
    .where(and(eq(pm.projectId, pid), eq(pm.userId, reviewerId!)));
  if (
    !reviewer ||
    reviewer.role === "client" ||
    reviewer.accountType !== "team" ||
    reviewer.status !== "active" ||
    !(
      await resolveProjectPermissions(
        tx,
        { id: reviewer.id, accountType: reviewer.accountType },
        pid,
      )
    ).canApproveMerge
  )
    fail(
      403,
      "REVIEWER_UNAVAILABLE",
      "지정 승인자의 프로젝트 참여 및 병합 승인 권한을 확인해주세요.",
    );
}
export function requireApprovedReview(
  task: { reviewStatus: string; reviewHeadSha: string; reviewBaseSha: string },
  headSha?: string,
  baseSha?: string,
) {
  if (
    task.reviewStatus !== "approved" ||
    !headSha ||
    task.reviewHeadSha !== headSha ||
    (baseSha !== undefined && task.reviewBaseSha !== baseSha)
  )
    fail(
      409,
      "MERGE_APPROVAL_REQUIRED",
      "현재 PR 변경 사항에 대한 병합 승인이 필요합니다.",
    );
}
