import { and, eq } from "drizzle-orm";
import { projectTasks as tasks, taskDependencies } from "../db/schema/project-work.js";
import type { DatabaseService } from "../db/database.service.js";
import { fail } from "../auth/security.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export async function hasPendingPredecessors(tx: Tx, projectId: string, taskId: string) {
  const visited = new Set([taskId]);
  const queue = [taskId];
  while (queue.length) {
    const rows = await tx.select({ id: tasks.id, status: tasks.status }).from(taskDependencies)
      .innerJoin(tasks, and(eq(tasks.id, taskDependencies.predecessorId), eq(tasks.projectId, projectId)))
      .where(eq(taskDependencies.taskId, queue.shift()!));
    for (const row of rows) {
      if (!["done", "released", "deploy_pending", "deploying"].includes(row.status)) return true;
      if (!visited.has(row.id)) { visited.add(row.id); queue.push(row.id); }
    }
  }
  return false;
}
export async function requirePredecessors(tx: Tx, projectId: string, taskId: string) {
  if (await hasPendingPredecessors(tx, projectId, taskId))
    fail(409, "PREDECESSOR_REQUIRED", "선행 업무의 작업 승인이 완료될 때까지 기다려주세요.");
}
