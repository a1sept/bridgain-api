import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { DatabaseService } from "../db/database.service.js";
import { activityEvents } from "../db/schema/activity.js";
import { projectRequests } from "../db/schema/requests.js";
import {
  taskRequests,
  taskAssignees,
  projectTasks,
} from "../db/schema/project-work.js";
import { users } from "../db/schema/auth.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export async function recordActivity(
  tx: Tx,
  data: {
    projectId: string;
    kind: string;
    category: "request" | "meeting" | "task" | "deployment";
    title: string;
    body?: string;
    actorId?: string | null;
    actorName?: string;
    meetingId?: string;
    taskId?: string;
    requestIds?: string[];
    sourceKey?: string;
  },
) {
  const requestIds = [
    ...new Set(
      data.requestIds ??
        (data.taskId
          ? (
              await tx
                .select()
                .from(taskRequests)
                .where(eq(taskRequests.taskId, data.taskId))
            ).map((r) => r.requestId)
          : []),
    ),
  ];
  const requests = requestIds.length
    ? await tx
        .select({
          id: projectRequests.id,
          title: projectRequests.title,
          origin: projectRequests.origin,
        })
        .from(projectRequests)
        .where(inArray(projectRequests.id, requestIds))
    : [];
  const assigned = data.taskId
    ? await tx
        .select({ id: taskAssignees.userId, name: users.displayName })
        .from(taskAssignees)
        .innerJoin(users, eq(users.id, taskAssignees.userId))
        .where(eq(taskAssignees.taskId, data.taskId))
    : [];
  const actor = data.actorId
    ? (
        await tx
          .select({ name: users.displayName })
          .from(users)
          .where(eq(users.id, data.actorId))
      )[0]
    : null;
  await tx
    .insert(activityEvents)
    .values({
      ...data,
      actorId: data.actorId ?? null,
      actorName: data.actorName ?? actor?.name ?? "시스템",
      requestIds,
      requests,
      assigneeIds: assigned.map((a) => a.id),
      body:
        data.body ??
        (data.kind === "task_assigned"
          ? assigned.map((a) => a.name).join(", ")
          : ""),
      sourceKey: data.sourceKey ?? randomUUID(),
      occurredAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing({ target: activityEvents.sourceKey });
}
export async function recordTaskActivity(
  tx: Tx,
  taskId: string,
  actorId: string | null,
  kind: string,
  body = "",
  sourceKey?: string,
  system = false,
) {
  const [task] = await tx
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.id, taskId));
  if (!task) return;
  await recordActivity(tx, {
    projectId: task.projectId,
    taskId,
    actorId: system ? null : actorId,
    kind,
    category: kind.startsWith("deploy") ? "deployment" : "task",
    title: task.title,
    body: body || undefined,
    sourceKey,
  });
}
