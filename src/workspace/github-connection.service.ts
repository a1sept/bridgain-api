import { projectRepositories } from "./project-repositories.js";
import {
  normalizeSubmoduleUrl,
  parseGitmodules,
  type RepositoryRelation,
} from "./submodules.js";
import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import { githubConnections, githubStates } from "../db/schema/github.js";
import { equal, fail } from "../auth/security.js";

export function seal(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function unseal(value: string, key: Buffer) {
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([
    cipher.update(bytes.subarray(12, -16)),
    cipher.final(),
  ]).toString();
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type GithubRepository = {
  id: number;
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  owner: { login: string; avatarUrl: string; type: string };
};
// External HTTP callbacks are allowed only for the explicitly configured development frontend.
export function validGithubCallback(callback: string): boolean {
  try {
    const url = new URL(callback);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "/api/workspace/github/callback") return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    return (
      process.env.NODE_ENV === "development" &&
      !!process.env.DEVELOPER_APP_ORIGIN &&
      url.origin === new URL(process.env.DEVELOPER_APP_ORIGIN).origin
    );
  } catch {
    return false;
  }
}
type DesktopAuthorization = {
  kind: "desktop";
  phase: "pending" | "exchanging" | "ready" | "failed";
  claimHash: string;
  verifier?: string;
  token?: string;
  tokenExpiresAt?: string;
  account?: { id: number; login: string };
};
const hashBase64 = (value: string) => createHash("sha256").update(value).digest("base64url");
@Injectable()
export class GithubConnectionService {
  constructor(private readonly database: DatabaseService) {}
  private config() {
    const {
      GITHUB_APP_CLIENT_ID: clientId,
      GITHUB_APP_CLIENT_SECRET: clientSecret,
      GITHUB_APP_SLUG: slug,
      GITHUB_APP_CALLBACK_URL: callback,
      GITHUB_TOKEN_ENCRYPTION_KEY: secret,
    } = process.env;
    if (
      !clientId ||
      !clientSecret ||
      !slug ||
      !callback ||
      !secret ||
      !/^[a-f0-9]{64}$/i.test(secret)
    )
      fail(
        503,
        "GITHUB_NOT_CONFIGURED",
        "GitHub 연결 설정이 준비되지 않았어요. 서비스 관리자에게 문의해주세요.",
      );
    if (!validGithubCallback(callback!))
      fail(
        503,
        "GITHUB_NOT_CONFIGURED",
        "GitHub 연결 주소 설정을 확인해주세요.",
      );
    return {
      clientId: clientId!,
      clientSecret: clientSecret!,
      slug: slug!,
      callback: callback!,
      key: Buffer.from(secret!, "hex"),
    };
  }
  async status(userId: string) {
    let configured = true;
    try {
      this.config();
    } catch {
      configured = false;
    }
    if (!configured)
      return { configured: false, connected: false, installUrl: null };
    const [row] = await this.database.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, userId));
    return {
      configured,
      connected: configured && !!row && row.expiresAt > new Date(),
      installUrl: configured
        ? `https://github.com/apps/${encodeURIComponent(this.config().slug)}/installations/new`
        : null,
    };
  }
  async desktopConnect(userId: string) {
    const c = this.config();
    const state = `desktop.${randomBytes(32).toString("hex")}`;
    const claimSecret = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    await this.database.db.delete(githubStates).where(lt(githubStates.expiresAt, new Date()));
    await this.database.db.insert(githubStates).values({
      state: hash(state), userId,
      verifier: seal(JSON.stringify({ kind: "desktop", phase: "pending", verifier, claimHash: hash(claimSecret) }), c.key),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.callback,
      state, code_challenge: hashBase64(verifier), code_challenge_method: "S256" }).toString();
    return { url: url.toString(), state, claimSecret };
  }
  private desktopState(state: unknown): string {
    if (typeof state !== "string" || !/^desktop\.[a-f0-9]{64}$/.test(state))
      fail(400, "GITHUB_STATE_INVALID", "GitHub 연결을 다시 시작해주세요.");
    return hash(state as string);
  }
  private desktopPayload(verifier: string): DesktopAuthorization {
    try {
      const value = JSON.parse(unseal(verifier, this.config().key));
      if (value.kind === "desktop" && typeof value.claimHash === "string") return value;
    } catch {}
    return fail(400, "GITHUB_STATE_INVALID", "GitHub 연결을 다시 시작해주세요.");
  }
  async desktopCallback(state: unknown, code: unknown, error?: unknown) {
    const key = this.desktopState(state), c = this.config();
    const [row] = await this.database.db.select().from(githubStates)
      .where(and(eq(githubStates.state, key), gt(githubStates.expiresAt, new Date())));
    if (!row) fail(400, "GITHUB_STATE_INVALID", "연결 요청이 만료되었거나 취소됐어요.");
    const payload = this.desktopPayload(row.verifier);
    if (payload.phase !== "pending") fail(400, "GITHUB_STATE_INVALID", "이미 처리된 연결 요청이에요.");
    const exchanging = seal(JSON.stringify({ ...payload, phase: "exchanging" }), c.key);
    const [claimed] = await this.database.db.update(githubStates).set({ verifier: exchanging })
      .where(and(eq(githubStates.state, key), eq(githubStates.verifier, row.verifier), gt(githubStates.expiresAt, new Date())))
      .returning();
    if (!claimed) fail(400, "GITHUB_STATE_INVALID", "이미 처리되었거나 취소된 연결 요청이에요.");
    let terminal: DesktopAuthorization = { kind: "desktop", phase: "failed", claimHash: payload.claimHash };
    if (error === undefined && typeof code === "string" && code.length > 0 && code.length <= 1024) {
      try {
        const response = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST", redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret,
            redirect_uri: c.callback, code, code_verifier: payload.verifier }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && typeof data.access_token === "string" && data.access_token) {
          const lifetime = Number(data.expires_in);
          const expiresAt = new Date(Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, 28800) : 28800) * 1000);
          const account = await this.api("/user", data.access_token);
          if (Number.isSafeInteger(account.id) && account.id > 0 && typeof account.login === "string" && /^[a-zA-Z0-9-]{1,39}$/.test(account.login))
            terminal = { kind: "desktop", phase: "ready", claimHash: payload.claimHash,
              token: data.access_token, tokenExpiresAt: expiresAt.toISOString(), account: { id: account.id, login: account.login } };
        }
      } catch { /* Store a terminal failure, never raw provider errors or credentials. */ }
    }
    // CAS prevents a cancelled/expired transaction from being resurrected after token exchange.
    const [saved] = await this.database.db.update(githubStates)
      .set({ verifier: seal(JSON.stringify(terminal), c.key) })
      .where(and(eq(githubStates.state, key), eq(githubStates.verifier, exchanging), gt(githubStates.expiresAt, new Date())))
      .returning();
    if (!saved) fail(400, "GITHUB_STATE_INVALID", "연결 요청이 만료되었거나 취소됐어요.");
    return { authorized: terminal.phase === "ready" };
  }
  private async desktopClaim(userId: string, state: unknown, claimSecret: unknown, cancel: boolean, confirm = false) {
    const key = this.desktopState(state);
    if (typeof claimSecret !== "string" || !/^[a-f0-9]{64}$/.test(claimSecret))
      fail(400, "GITHUB_STATE_INVALID", "GitHub 연결을 다시 시작해주세요.");
    return this.database.db.transaction(async tx => {
      const [row] = await tx.select().from(githubStates)
        .where(and(eq(githubStates.state, key), eq(githubStates.userId, userId), gt(githubStates.expiresAt, new Date())))
        .for("update");
      if (!row || row.expiresAt <= new Date()) fail(400, "GITHUB_STATE_INVALID", "연결 요청이 만료되었거나 이미 처리됐어요.");
      const payload = this.desktopPayload(row.verifier);
      if (!equal(payload.claimHash, hash(claimSecret as string)))
        fail(400, "GITHUB_STATE_INVALID", "GitHub 연결 확인 정보가 일치하지 않아요.");
      if (!cancel && ["pending", "exchanging"].includes(payload.phase)) return "pending";
      if (!cancel && payload.phase === "ready" && !confirm && payload.account && payload.tokenExpiresAt && new Date(payload.tokenExpiresAt) > new Date())
        return { connected: false as const, ready: true as const, account: payload.account };
      await tx.delete(githubStates).where(eq(githubStates.state, key));
      if (cancel) return "cancelled";
      if (payload.phase !== "ready" || !payload.token || !payload.tokenExpiresAt || new Date(payload.tokenExpiresAt) <= new Date()) return "failed";
      const token = seal(payload.token, this.config().key), expiresAt = new Date(payload.tokenExpiresAt);
      await tx.insert(githubConnections).values({ userId, token, expiresAt })
        .onConflictDoUpdate({ target: githubConnections.userId, set: { token, expiresAt } });
      return "connected";
    });
  }
  async desktopComplete(userId: string, state: unknown, claimSecret: unknown, confirm = false) {
    const result = await this.desktopClaim(userId, state, claimSecret, false, confirm);
    if (typeof result === "object") return result;
    if (result === "pending") return { connected: false };
    if (result !== "connected") fail(400, "GITHUB_AUTH_FAILED", "GitHub 인증이 완료되지 않았어요. 다시 연결해주세요.");
    try { return { connected: true, installUrl: await this.installationUrlIfNeeded(userId) }; }
    catch { return { connected: true, installUrl: null, repositoryCheckFailed: true }; }
  }
  async desktopCancel(userId: string, state: unknown, claimSecret: unknown) {
    await this.desktopClaim(userId, state, claimSecret, true);
    return { ok: true };
  }
  async connect(userId: string) {
    const status = await this.status(userId);
    if (status.connected) {
      try {
        const repos = await this.repositories(userId);
        return {
          url: repos.length
            ? `${this.config().callback}/complete`
            : status.installUrl!,
        };
      } catch (error) {
        // Revoked/expired authorization needs a fresh OAuth flow, not a dead end.
        const code = (error as { getStatus?: () => number }).getStatus?.();
        if (code !== 403 && code !== 409) throw error;
      }
    }
    return this.start(userId);
  }
  async installationUrlIfNeeded(userId: string): Promise<string | null> {
    if ((await this.repositories(userId)).length) return null;
    return `https://github.com/apps/${encodeURIComponent(this.config().slug)}/installations/new`;
  }
  async start(userId: string) {
    const c = this.config();
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    await this.database.db
      .delete(githubStates)
      .where(lt(githubStates.expiresAt, new Date()));
    await this.database.db.insert(githubStates).values({
      state: hash(state),
      userId,
      verifier: seal(verifier, c.key),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.callback,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  }
  async callback(userId: string, state: unknown, code: unknown) {
    const c = this.config();
    if (
      typeof state !== "string" ||
      !/^[a-f0-9]{64}$/.test(state) ||
      typeof code !== "string" ||
      !code ||
      code.length > 1024
    )
      fail(400, "GITHUB_STATE_INVALID", "GitHub 연결을 다시 시작해주세요.");
    const [pending] = await this.database.db
      .delete(githubStates)
      .where(
        and(
          eq(githubStates.state, hash(state as string)),
          eq(githubStates.userId, userId),
          gt(githubStates.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!pending)
      fail(
        400,
        "GITHUB_STATE_INVALID",
        "연결 요청이 만료되었어요. 다시 시작해주세요.",
      );
    let response: Response;
    try {
      response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          redirect_uri: c.callback,
          code,
          code_verifier: unseal(pending.verifier, c.key),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return fail(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub에 연결하지 못했어요. 다시 시도해주세요.",
      );
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.access_token !== "string")
      fail(
        400,
        "GITHUB_AUTH_FAILED",
        "GitHub 인증이 완료되지 않았어요. 다시 연결해주세요.",
      );
    // Keep user credentials short-lived locally; reconnect when expired. Never expose tokens to the browser.
    const expiresAt = new Date(
      Date.now() + Math.min(Number(data.expires_in) || 28800, 28800) * 1000,
    );
    const token = seal(data.access_token, c.key);
    await this.database.db
      .insert(githubConnections)
      .values({ userId, token, expiresAt })
      .onConflictDoUpdate({
        target: githubConnections.userId,
        set: { token, expiresAt },
      });
  }
  async disconnect(userId: string) {
    await this.database.db
      .delete(githubConnections)
      .where(eq(githubConnections.userId, userId));
    await this.database.db
      .delete(githubStates)
      .where(eq(githubStates.userId, userId));
    return { ok: true };
  }
  private async api(path: string, token: string, method = "GET", body?: object): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return fail(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub에 연결하지 못했어요. 다시 시도해주세요.",
      );
    }
    if (response.status === 401)
      fail(409, "GITHUB_CONNECT_REQUIRED", "GitHub 인증이 만료되었거나 취소되었습니다. 내 GitHub 계정을 다시 연결해주세요.");
    if (response.status === 404)
      fail(404, "GITHUB_RESOURCE_UNAVAILABLE", "저장소 또는 PR이 없거나 현재 GitHub 계정에 공개되지 않았습니다. 주소와 협업자·앱 설치 권한을 확인해주세요.");
    if (response.status === 403)
      fail(
        403,
        "GITHUB_ACCESS_DENIED",
        "GitHub 요청이 권한 또는 사용 제한으로 거절되었습니다. 저장소 협업자 권한과 GitHub App 설치 권한 승인을 확인해주세요.",
      );
    if (!response.ok)
      fail(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub 데이터를 가져오지 못했어요. 잠시 후 다시 시도해주세요.",
      );
    return response.json();
  }
  async repositoryRequest(userId: string, repositoryUrl: string, suffix: string, method = "GET", body?: object): Promise<any> {
    await this.verify(userId, [repositoryUrl]);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repositoryUrl) || !suffix.startsWith("/") || suffix.includes(".."))
      fail(400, "INVALID_GITHUB_PATH", "저장소 경로를 확인해주세요.");
    const [row] = await this.database.db.select().from(githubConnections)
      .where(and(eq(githubConnections.userId, userId), gt(githubConnections.expiresAt, new Date())));
    if (!row) fail(409, "GITHUB_CONNECT_REQUIRED", "GitHub 연결이 만료되었습니다. 다시 연결해주세요.");
    return this.api(`/repos/${repositoryUrl.slice("https://github.com/".length)}${suffix}`, unseal(row.token, this.config().key), method, body);
  }
  async repositories(userId: string): Promise<GithubRepository[]> {
    const c = this.config();
    const [row] = await this.database.db
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.userId, userId),
          gt(githubConnections.expiresAt, new Date()),
        ),
      );
    if (!row)
      fail(
        409,
        "GITHUB_CONNECT_REQUIRED",
        "GitHub를 먼저 연결해주세요. 만료된 연결은 다시 인증해주세요.",
      );
    const token = unseal(row.token, c.key);
    const result: GithubRepository[] = [];
    for (let page = 1; ; page++) {
      const data = await this.api(
        `/user/installations?per_page=100&page=${page}`,
        token,
      );
      for (const install of data.installations) {
        for (let repoPage = 1; ; repoPage++) {
          const repos = await this.api(
            `/user/installations/${install.id}/repositories?per_page=100&page=${repoPage}`,
            token,
          );
          for (const repo of repos.repositories)
            result.push({
              id: repo.id,
              fullName: repo.full_name,
              url: repo.html_url,
              private: repo.private,
              defaultBranch: repo.default_branch,
              installationId: install.id,
              owner: {
                login: repo.owner?.login ?? repo.full_name.split("/")[0],
                avatarUrl: repo.owner?.avatar_url ?? "",
                type: repo.owner?.type ?? "User",
              },
            });
          if (repos.repositories.length < 100) break;
        }
      }
      if (data.installations.length < 100) break;
    }
    return result.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  async submodules(userId: string, repository: unknown, ref?: unknown) {
    const parentUrl = projectRepositories([repository])[0];
    if (
      ref !== undefined &&
      (typeof ref !== "string" || !/^[a-f0-9]{40}$/.test(ref))
    )
      fail(400, "VALIDATION_ERROR", "부모 참조 커밋을 확인해주세요.");
    const accessible = await this.repositories(userId);
    const parent = accessible.find(
      (r) => r.url.toLowerCase() === parentUrl.toLowerCase(),
    );
    if (!parent)
      fail(
        403,
        "GITHUB_REPOSITORY_DENIED",
        "상위 저장소 접근 권한이 필요해요.",
      );
    const [connection] = await this.database.db
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.userId, userId),
          gt(githubConnections.expiresAt, new Date()),
        ),
      );
    if (!connection)
      fail(409, "GITHUB_CONNECT_REQUIRED", "GitHub를 다시 연결해주세요.");
    const token = unseal(connection.token, this.config().key);
    const repoPath = parent!.fullName
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const commit = await this.api(
      `/repos/${repoPath}/commits/${encodeURIComponent((ref as string) || parent!.defaultBranch)}`,
      token,
    );
    const tree = await this.api(
      `/repos/${repoPath}/git/trees/${commit.commit.tree.sha}?recursive=1`,
      token,
    );
    if (tree.truncated)
      fail(
        422,
        "GITHUB_TREE_TOO_LARGE",
        "저장소가 커서 서브모듈을 모두 확인할 수 없어요.",
      );
    const links = tree.tree.filter(
      (entry: any) => entry.mode === "160000" && entry.type === "commit",
    );
    if (links.length > 100)
      fail(
        422,
        "GITHUB_TOO_MANY_SUBMODULES",
        "서브모듈은 최대 100개까지 조회할 수 있어요.",
      );
    if (!links.length)
      return {
        parentUrl: parent!.url,
        parentCommit: commit.sha,
        submodules: [],
      };
    const file = await this.api(
      `/repos/${repoPath}/contents/.gitmodules?ref=${commit.sha}`,
      token,
    );
    if (
      file.encoding !== "base64" ||
      typeof file.content !== "string" ||
      file.size > 262144
    )
      fail(422, "INVALID_GITMODULES", ".gitmodules 파일을 확인해주세요.");
    const entries = parseGitmodules(
      Buffer.from(file.content, "base64").toString("utf8"),
    );
    return {
      parentUrl: parent!.url,
      parentCommit: commit.sha,
      submodules: links.map((entry: any) => {
        const rawUrl = entries.get(entry.path) ?? "";
        const childUrl = rawUrl
          ? normalizeSubmoduleUrl(rawUrl, parent!.url)
          : null;
        const child = accessible.find(
          (r) => r.url.toLowerCase() === childUrl?.toLowerCase(),
        );
        return {
          parentUrl: parent!.url,
          parentCommit: commit.sha,
          path: entry.path,
          commit: entry.sha,
          childUrl: child?.url ?? childUrl,
          rawUrl,
          available: !!child,
          reason: !childUrl
            ? "지원하지 않는 저장소 주소"
            : !child
              ? "GitHub 접근 권한 필요"
              : null,
        };
      }),
    };
  }
  async verifyRelations(userId: string, relations: RepositoryRelation[]) {
    const snapshots = new Map<
      string,
      Awaited<ReturnType<GithubConnectionService["submodules"]>>
    >();
    for (const relation of relations) {
      const key = `${relation.parentUrl}:${relation.parentCommit}`;
      if (!snapshots.has(key))
        snapshots.set(
          key,
          await this.submodules(
            userId,
            relation.parentUrl,
            relation.parentCommit,
          ),
        );
      const actual = snapshots
        .get(key)!
        .submodules.find((r: any) => r.path === relation.path);
      if (
        !actual?.available ||
        actual.childUrl?.toLowerCase() !== relation.childUrl.toLowerCase() ||
        actual.commit !== relation.commit
      )
        fail(
          400,
          "INVALID_SUBMODULE_RELATION",
          "GitHub의 실제 서브모듈 관계와 일치하지 않아요. 다시 조회해주세요.",
        );
    }
  }
  async verify(userId: string, urls: string[]) {
    if (!urls.length) return;
    const allowed = new Set(
      (await this.repositories(userId)).map((r) => r.url.toLowerCase()),
    );
    if (urls.some((url) => !allowed.has(url.toLowerCase())))
      fail(
        403,
        "GITHUB_REPOSITORY_DENIED",
        "연결된 GitHub에서 접근 가능한 저장소를 선택해주세요.",
      );
  }
}
