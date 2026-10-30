import { createPrivateKey, sign } from "node:crypto";
import { fail } from "../auth/security.js";

// Deployment-owned grants, never editable through a project settings request.
// A URL in projects.repository_urls is metadata, not permission to use global App credentials.
export function projectRepositoryGranted(projectId: string, repository: string): boolean {
  try {
    const grants = JSON.parse(process.env.GITHUB_PROJECT_REPOSITORIES || "{}");
    return !!grants && typeof grants === "object" && !Array.isArray(grants)
      && Object.prototype.hasOwnProperty.call(grants, projectId)
      && Array.isArray(grants[projectId]) && grants[projectId].includes(repository);
  } catch { return false; }
}
export function projectGithubConfigured(projectId: string, repository: string): boolean {
  return projectRepositoryGranted(projectId, repository)
    && (!!process.env.GITHUB_APP_ID && !!process.env.GITHUB_APP_PRIVATE_KEY || !!process.env.GITHUB_MERGE_TOKEN);
}
function appJwt() {
  const id = process.env.GITHUB_APP_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!id || !/^\d+$/.test(id) || !pem)
    fail(503, "GITHUB_PROJECT_AUTH_REQUIRED", "프로젝트 관리자가 서버의 GitHub App 연동을 설정해야 합니다. 개인 GitHub 연결이나 로컬 폴더는 필요하지 않습니다.");
  try {
    const key = createPrivateKey(pem!.replace(/\\n/g, "\n"));
    if (key.asymmetricKeyType !== "rsa") throw Error("invalid key");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id })).toString("base64url");
    const data = `${header}.${payload}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
  } catch {
    return fail(503, "GITHUB_PROJECT_AUTH_REQUIRED", "서버의 GitHub App 개인 키 설정을 확인해주세요.");
  }
}
async function request<T>(path: string, token: string, method = "GET", body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch { return fail(502, "GITHUB_UNAVAILABLE", "GitHub 응답을 확인하지 못했습니다. 잠시 후 다시 확인해주세요."); }
  if ([401, 403, 404].includes(response.status))
    fail(409, "GITHUB_PROJECT_ACCESS_REQUIRED", "프로젝트 관리자가 GitHub App 설치 대상 저장소와 Contents·Pull requests 읽기/쓰기 권한의 설치 승인 여부를 확인해야 합니다.");
  if (!response.ok) fail(409, "GITHUB_REJECTED", "GitHub 요청이 거절됐습니다. PR 상태, 충돌, 필수 검사와 연동 권한을 확인해주세요.");
  return response.json() as Promise<T>;
}
export async function projectGithubRequest<T>(projectId: string, repository: string, suffix: string, method = "GET", body?: object): Promise<T> {
  if (!projectRepositoryGranted(projectId, repository))
    fail(503, "GITHUB_PROJECT_AUTH_REQUIRED", "프로젝트 관리자가 이 저장소의 서버 접근 권한을 연결해야 합니다. 개인 GitHub 연결이나 로컬 폴더는 필요하지 않습니다.");
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match || !suffix.startsWith("/") || suffix.startsWith("//") || /[\\#\r\n]/.test(suffix) || /(?:\.\.|%2e|%5c)/i.test(suffix.split("?")[0]) || !["GET", "POST", "PUT"].includes(method))
    fail(400, "INVALID_GITHUB_PATH", "저장소 경로를 확인해주세요.");
  const prefix = `/repos/${match![1]}/${match![2]}`;
  // Keep the explicitly mapped legacy deployment credential usable during migration.
  if (!process.env.GITHUB_APP_ID && !process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_MERGE_TOKEN)
    return request<T>(prefix + suffix, process.env.GITHUB_MERGE_TOKEN, method, body);
  const jwt = appJwt();
  const installation = await request<{ id: number; suspended_at?: string | null }>(`${prefix}/installation`, jwt);
  if (!Number.isSafeInteger(installation.id) || installation.id <= 0 || installation.suspended_at)
    fail(409, "GITHUB_PROJECT_ACCESS_REQUIRED", "이 저장소의 GitHub App 설치 상태를 확인해주세요.");
  const permission = method === "GET" ? "read" : "write";
  const access = await request<{ token: string; expires_at: string }>(`/app/installations/${installation.id}/access_tokens`, jwt, "POST", {
    repositories: [match![2]],
    permissions: { contents: method === "PUT" ? "write" : "read", pull_requests: permission },
  });
  if (!access.token || typeof access.token !== "string" || !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= Date.now())
    fail(502, "GITHUB_UNAVAILABLE", "GitHub 저장소 접근 토큰을 확인하지 못했습니다.");
  return request<T>(prefix + suffix, access.token, method, body);
}
