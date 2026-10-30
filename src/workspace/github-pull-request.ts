import { fail } from "../auth/security.js";

export type PullRequest = {
  html_url: string;
  state: string;
  merged: boolean;
  draft: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { html_url: string } | null };
  base: { sha: string; ref: string; repo: { html_url: string } | null };
};
export function pullRequestPath(
  projectId: string,
  repository: string | null,
  url: string | null,
  allowedRepositories?: string[],
) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(
      url ?? "",
    );
  if (!match || repository !== `https://github.com/${match[1]}/${match[2]}`)
    fail(400, "INVALID_PR", "업무 저장소의 GitHub PR 링크를 입력해주세요.");
  let mappings: Record<string, unknown> = {};
  try {
    mappings = JSON.parse(process.env.GITHUB_PROJECT_REPOSITORIES || "{}");
  } catch {}
  if (
    !allowedRepositories?.includes(repository!) && (!mappings ||
    !Array.isArray(mappings[projectId]) ||
    !(mappings[projectId] as unknown[]).includes(repository))
  )
    fail(
      503,
      "GITHUB_NOT_CONFIGURED",
      "프로젝트의 GitHub 저장소 연동을 서버에 설정해주세요.",
    );
  return `/repos/${match![1]}/${match![2]}/pulls/${match![3]}`;
}
export async function github<T>(path: string, body?: object): Promise<T> {
  const token = process.env.GITHUB_MERGE_TOKEN;
  if (!token)
    fail(
      503,
      "GITHUB_NOT_CONFIGURED",
      "GitHub 병합 연동이 설정되지 않았습니다.",
    );
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method: body ? "PUT" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return fail(
      502,
      "GITHUB_UNAVAILABLE",
      "GitHub 응답을 확인하지 못했습니다. 병합 결과를 다시 확인해주세요.",
    );
  }
  if (!response.ok)
    fail(
      409,
      "GITHUB_REJECTED",
      "GitHub 요청이 거절됐습니다. PR 상태, 충돌, 필수 검사와 연동 권한을 확인해주세요.",
    );
  return response.json() as Promise<T>;
}
export function checkPullRequest(
  pr: PullRequest,
  task: {
    repositoryUrl: string | null;
    pullRequestUrl: string | null;
    workBranch: string;
    liveBranch: string;
  },
  allowMerged = false,
) {
  if (
    !pr ||
    pr.html_url !== task.pullRequestUrl ||
    pr.head?.repo?.html_url !== task.repositoryUrl ||
    pr.base?.repo?.html_url !== task.repositoryUrl ||
    pr.head?.ref !== task.workBranch ||
    pr.base?.ref !== task.liveBranch ||
    !/^[a-f0-9]{40}$/i.test(pr.head?.sha ?? "") ||
    !/^[a-f0-9]{40}$/i.test(pr.base?.sha ?? "") ||
    (pr.merged ? !allowMerged : pr.state !== "open" || pr.draft)
  )
    fail(
      409,
      "PR_CHANGED",
      "열린 PR과 업무의 저장소·브랜치 연결을 확인해주세요. 초안 PR은 검토 요청할 수 없습니다.",
    );
}
