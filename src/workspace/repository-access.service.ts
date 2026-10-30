import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { fail } from "../auth/security.js";
import { uuid, bounded } from "./workspace.service.js";
import { projectRepositories } from "./project-repositories.js";

type User = { id: string; displayName: string; accountType: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export function repositoryAccessInput(body: Record<string, unknown>) {
  const urls = projectRepositories([body?.repositoryUrl]);
  return {
    repositoryUrl: urls[0],
    note: body?.note ? bounded(body.note, 1000) : "",
  };
}
@Injectable()
export class RepositoryAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  private async context(tx: Tx, u: User, pid: string) {
    const access = await this.requests.access(tx, u, uuid(pid), true);
    if (!access.isDeveloper)
      fail(
        403,
        "FORBIDDEN",
        "프로젝트 개발팀만 저장소 접근을 요청할 수 있습니다.",
      );
    return access;
  }
  private async registered(tx: Tx, pid: string, repo: string) {
    const result = await tx.execute(
      sql`SELECT id FROM projects WHERE id=${pid} AND ${repo}=ANY(repository_urls) FOR UPDATE`,
    );
    if (!result.rows.length)
      fail(
        403,
        "REPOSITORY_DENIED",
        "프로젝트에 등록된 저장소만 요청할 수 있습니다.",
      );
  }
  private async member(tx: Tx, pid: string, id: string) {
    const result = await tx.execute(
      sql`SELECT u.id,u.display_name FROM project_memberships pm JOIN projects p ON p.id=pm.project_id JOIN team_memberships tm ON tm.team_id=p.team_id AND tm.user_id=pm.user_id JOIN users u ON u.id=pm.user_id WHERE pm.project_id=${pid} AND pm.user_id=${id} AND pm.access_role<>'client' AND u.account_type='team' AND u.status='active'`,
    );
    if (!result.rows.length)
      fail(
        400,
        "INVALID_REPOSITORY_MANAGER",
        "현재 프로젝트 개발팀 구성원을 담당자로 지정해주세요.",
      );
    return result.rows[0];
  }
  private async notify(tx: Tx, u: User, pid: string, body: string) {
    await tx.execute(
      sql`INSERT INTO channel_messages(project_id,actor_id,body) VALUES(${pid},${u.id},${body})`,
    );
  }
  async list(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.context(tx, u, pid);
      const repositories = await tx.execute(
        sql`SELECT r.url AS "repositoryUrl",CASE WHEN EXISTS (SELECT 1 FROM project_memberships pm JOIN team_memberships tm ON tm.team_id=p.team_id AND tm.user_id=pm.user_id WHERE pm.project_id=p.id AND pm.user_id=m.manager_user_id AND pm.access_role<>'client') AND u.status='active' AND u.account_type='team' THEN m.manager_user_id ELSE NULL END AS "managerUserId",u.display_name AS "managerName" FROM projects p CROSS JOIN LATERAL unnest(p.repository_urls) AS r(url) LEFT JOIN project_repository_managers m ON m.project_id=p.id AND m.repository_url=r.url LEFT JOIN users u ON u.id=m.manager_user_id WHERE p.id=${pid}`,
      );
      const requests = await tx.execute(
        sql`SELECT a.id,a.repository_url AS "repositoryUrl",a.requester_id AS "requesterId",u.display_name AS "requesterName",a.manager_user_id AS "managerUserId",a.status,a.note,a.created_at AS "createdAt",a.resolved_at AS "resolvedAt" FROM repository_access_requests a JOIN users u ON u.id=a.requester_id WHERE a.project_id=${pid} AND (a.status='pending' OR a.id IN (SELECT id FROM repository_access_requests WHERE project_id=${pid} AND status='resolved' ORDER BY created_at DESC,id DESC LIMIT 100)) ORDER BY (a.status='pending') DESC,a.created_at DESC,a.id DESC`,
      );
      const members = await tx.execute(
        sql`SELECT u.id AS "userId",u.display_name AS "displayName" FROM project_memberships pm JOIN projects p ON p.id=pm.project_id JOIN team_memberships tm ON tm.team_id=p.team_id AND tm.user_id=pm.user_id JOIN users u ON u.id=pm.user_id WHERE pm.project_id=${pid} AND pm.access_role<>'client' AND u.account_type='team' AND u.status='active' ORDER BY u.display_name,u.id`,
      );
      return {
        currentUserId: u.id,
        members: members.rows,
        repositories: repositories.rows.map((r) => ({
          ...r,
          managerName: r.managerUserId ? r.managerName : null,
        })),
        requests: requests.rows,
        canManage: access.permissions.includes("project.settings"),
      };
    });
  }
  async manager(u: User, pid: string, b: Record<string, unknown>) {
    const { repositoryUrl: repo } = repositoryAccessInput(b);
    const managerId = b.managerUserId === null ? null : uuid(b.managerUserId);
    return this.database.db.transaction(async (tx) => {
      const access = await this.context(tx, u, pid);
      requireProjectPermission(access, "project.settings");
      await this.registered(tx, pid, repo);
      const member = managerId ? await this.member(tx, pid, managerId) : null;
      const previous = await tx.execute(
        sql`SELECT manager_user_id FROM project_repository_managers WHERE project_id=${pid} AND repository_url=${repo}`,
      );
      await tx.execute(
        sql`INSERT INTO project_repository_managers(project_id,repository_url,manager_user_id) VALUES(${pid},${repo},${managerId}) ON CONFLICT(project_id,repository_url) DO UPDATE SET manager_user_id=EXCLUDED.manager_user_id`,
      );
      await tx.execute(
        sql`UPDATE repository_access_requests SET manager_user_id=${managerId} WHERE project_id=${pid} AND repository_url=${repo} AND status='pending'`,
      );
      if (managerId && previous.rows[0]?.manager_user_id !== managerId)
        await this.notify(
          tx,
          u,
          pid,
          `저장소 담당자 지정: ${String(member!.display_name)} · ${repo}. 프로젝트 설정에서 저장소 접근 요청을 확인해주세요.`,
        );
      return { ok: true };
    });
  }
  async request(u: User, pid: string, b: Record<string, unknown>) {
    const { repositoryUrl: repo, note } = repositoryAccessInput(b);
    return this.database.db.transaction(async (tx) => {
      await this.context(tx, u, pid);
      await this.registered(tx, pid, repo);
      const manager = await tx.execute(
        sql`SELECT manager_user_id FROM project_repository_managers WHERE project_id=${pid} AND repository_url=${repo}`,
      );
      const managerId = manager.rows[0]?.manager_user_id as string | undefined;
      if (!managerId)
        fail(
          409,
          "REPOSITORY_MANAGER_REQUIRED",
          "프로젝트 관리자가 먼저 저장소 담당자를 지정해야 합니다.",
        );
      const target = await this.member(tx, pid, managerId!);
      const result = await tx.execute(
        sql`INSERT INTO repository_access_requests(project_id,repository_url,requester_id,manager_user_id,note) VALUES(${pid},${repo},${u.id},${managerId},${note}) ON CONFLICT(project_id,repository_url,requester_id) WHERE status='pending' DO NOTHING RETURNING id`,
      );
      if (!result.rows.length) {
        const existing = await tx.execute(
          sql`SELECT id FROM repository_access_requests WHERE project_id=${pid} AND repository_url=${repo} AND requester_id=${u.id} AND status='pending'`,
        );
        return { id: existing.rows[0].id, duplicate: true };
      }
      await this.notify(
        tx,
        u,
        pid,
        `저장소 접근 요청 · 담당자 ${String(target.display_name)}: ${u.displayName}님이 ${repo} 접근을 요청했습니다.${note ? "\n" + note : ""}\n프로젝트 설정에서 확인해주세요. GitHub 권한은 담당자가 직접 확인해야 합니다.`,
      );
      return { id: result.rows[0].id, duplicate: false };
    });
  }
  async resolve(u: User, pid: string, id: string, b: Record<string, unknown>) {
    if (b?.status !== "resolved")
      fail(400, "VALIDATION_ERROR", "처리 완료 상태만 지정할 수 있습니다.");
    return this.database.db.transaction(async (tx) => {
      const access = await this.context(tx, u, pid);
      const result = await tx.execute(
        sql`SELECT * FROM repository_access_requests WHERE project_id=${pid} AND id=${uuid(id)} FOR UPDATE`,
      );
      const row = result.rows[0];
      if (!row) fail(404, "NOT_FOUND", "접근 요청을 찾을 수 없습니다.");
      if (
        row.manager_user_id !== u.id &&
        !access.permissions.includes("project.settings")
      )
        fail(
          403,
          "FORBIDDEN",
          "지정 담당자나 프로젝트 관리자만 처리할 수 있습니다.",
        );
      if (row.status === "resolved") return { ok: true };
      await tx.execute(
        sql`UPDATE repository_access_requests SET status='resolved',resolved_at=clock_timestamp(),resolved_by=${u.id} WHERE id=${id}`,
      );
      await this.notify(
        tx,
        u,
        pid,
        `저장소 접근 요청 처리 완료: ${String(row.repository_url)}. 실제 GitHub 접근 가능 여부는 요청자가 확인해주세요.`,
      );
      return { ok: true };
    });
  }
}
