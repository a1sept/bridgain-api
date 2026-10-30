import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { RequestsService } from "./requests.service.js";
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
  private async candidates(tx: Tx, pid: string) {
    const result = await tx.execute(
      sql`SELECT u.id,u.display_name FROM project_memberships pm JOIN projects p ON p.id=pm.project_id JOIN team_memberships tm ON tm.team_id=p.team_id AND tm.user_id=pm.user_id JOIN users u ON u.id=pm.user_id WHERE pm.project_id=${pid} AND pm.access_role<>'client' AND u.account_type='team' AND u.status='active' ORDER BY u.id`,
    );
    return result.rows as { id: string; display_name: string }[];
  }
  private async routing(
    tx: Tx,
    pid: string,
    repo: string,
    candidates?: { id: string; display_name: string }[],
  ) {
    const result = await tx.execute(
      sql`SELECT p.created_by,r.registered_by,u.display_name AS registered_name FROM projects p LEFT JOIN project_repository_registrations r ON r.project_id=p.id AND r.repository_url=lower(${repo}) LEFT JOIN users u ON u.id=r.registered_by WHERE p.id=${pid}`,
    );
    const origin = result.rows[0];
    const members = candidates ?? (await this.candidates(tx, pid));
    const registrant = origin?.registered_by as string | undefined;
    let target = members.find(
      (m) => m.id === (registrant || origin?.created_by),
    );
    let source = target
      ? registrant
        ? "registrant"
        : "project_creator"
      : "unavailable";
    if (!target)
      for (const member of members) {
        const access = await this.requests.access(
          tx,
          {
            id: member.id,
            displayName: member.display_name,
            accountType: "team",
          },
          pid,
        );
        if (
          access.isDeveloper &&
          access.permissions.includes("project.settings")
        ) {
          target = member;
          source = "project_admin";
          break;
        }
      }
    return {
      repositoryUrl: repo,
      registeredByUserId: registrant ?? null,
      registeredByName: origin?.registered_name ?? null,
      recipientUserId: target?.id ?? null,
      recipientName: target?.display_name ?? null,
      recipientSource: source,
    };
  }
  private async notify(tx: Tx, u: User, pid: string, body: string) {
    await tx.execute(
      sql`INSERT INTO channel_messages(project_id,actor_id,body) VALUES(${pid},${u.id},${body})`,
    );
  }
  async list(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const access = await this.context(tx, u, pid);
      const registered = await tx.execute(
        sql`SELECT unnest(repository_urls) AS repository_url FROM projects WHERE id=${pid}`,
      );
      const candidates = await this.candidates(tx, pid);
      const repositories: Awaited<ReturnType<RepositoryAccessService["routing"]>>[] = [];
      for (const row of registered.rows)
        repositories.push(
          await this.routing(tx, pid, String(row.repository_url), candidates),
        );
      const requests = await tx.execute(
        sql`SELECT a.id,a.repository_url AS "repositoryUrl",a.requester_id AS "requesterId",u.display_name AS "requesterName",a.manager_user_id AS "recipientUserId",a.status,a.note,a.created_at AS "createdAt",a.resolved_at AS "resolvedAt" FROM repository_access_requests a JOIN users u ON u.id=a.requester_id WHERE a.project_id=${pid} AND (a.status='pending' OR a.id IN (SELECT id FROM repository_access_requests WHERE project_id=${pid} AND status='resolved' ORDER BY created_at DESC,id DESC LIMIT 100)) ORDER BY (a.status='pending') DESC,a.created_at DESC,a.id DESC`,
      );
      return {
        currentUserId: u.id,
        repositories,
        requests: requests.rows.map((row) =>
          row.status === "pending"
            ? {
                ...row,
                recipientUserId:
                  repositories.find(
                    (r) => r.repositoryUrl === row.repositoryUrl,
                  )?.recipientUserId ?? null,
              }
            : row,
        ),
        canManage: access.permissions.includes("project.settings"),
      };
    });
  }
  async request(u: User, pid: string, b: Record<string, unknown>) {
    const { repositoryUrl: repo, note } = repositoryAccessInput(b);
    return this.database.db.transaction(async (tx) => {
      await this.context(tx, u, pid);
      await this.registered(tx, pid, repo);
      const target = await this.routing(tx, pid, repo);
      const managerId = target.recipientUserId;
      if (!managerId)
        fail(
          409,
          "REPOSITORY_RECIPIENT_UNAVAILABLE",
          "저장소 등록자와 요청을 받을 프로젝트 관리자가 없습니다. 프로젝트 관리자에게 구성원 권한 확인을 요청해주세요.",
        );
      const result = await tx.execute(
        sql`INSERT INTO repository_access_requests(project_id,repository_url,requester_id,manager_user_id,note) VALUES(${pid},${repo},${u.id},${managerId},${note}) ON CONFLICT(project_id,repository_url,requester_id) WHERE status='pending' DO NOTHING RETURNING id`,
      );
      if (!result.rows.length) {
        const existing = await tx.execute(
          sql`SELECT id FROM repository_access_requests WHERE project_id=${pid} AND repository_url=${repo} AND requester_id=${u.id} AND status='pending'`,
        );
        await tx.execute(
          sql`UPDATE repository_access_requests SET manager_user_id=${managerId} WHERE id=${existing.rows[0].id}`,
        );
        return { id: existing.rows[0].id, duplicate: true };
      }
      await this.notify(
        tx,
        u,
        pid,
        `저장소 접근 요청 · 수신자 ${String(target.recipientName)}: ${u.displayName}님이 ${repo} 접근을 요청했습니다.${note ? "\n" + note : ""}\n프로젝트 설정에서 확인해주세요. GitHub 권한은 수신자가 직접 확인해야 합니다.`,
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
      const target = await this.routing(tx, pid, String(row.repository_url));
      if (
        target.recipientUserId !== u.id &&
        !access.permissions.includes("project.settings")
      )
        fail(
          403,
          "FORBIDDEN",
          "저장소 등록자 또는 요청 수신자·프로젝트 관리자만 처리할 수 있습니다.",
        );
      if (row.status === "resolved") return { ok: true };
      await tx.execute(
        sql`UPDATE repository_access_requests SET status='resolved',resolved_at=clock_timestamp(),resolved_by=${u.id},manager_user_id=${target.recipientUserId} WHERE id=${id}`,
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
