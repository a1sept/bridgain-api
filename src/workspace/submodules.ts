import { fail } from "../auth/security.js";
import { projectRepositories } from "./project-repositories.js";
export type RepositoryRelation = {
  parentUrl: string;
  childUrl: string;
  path: string;
  commit: string;
  parentCommit: string;
};
export function normalizeSubmoduleUrl(
  raw: string,
  parent: string,
): string | null {
  let url = raw
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  if (/^\.\.?\//.test(url)) url = new URL(url, `${parent}/`).toString();
  try {
    return projectRepositories([url])[0];
  } catch {
    return null;
  }
}
function configValue(raw: string) {
  if (!raw.startsWith('"')) return raw.replace(/\s+[;#].*$/, "").trim();
  const match = /^"((?:[^"\\]|\\.)*)"\s*(?:[;#].*)?$/.exec(raw);
  if (!match)
    fail(422, "INVALID_GITMODULES", ".gitmodules 형식을 확인해주세요.");
  return match![1].replace(
    /\\([\\"ntb])/g,
    (_, c: string) =>
      (({ n: "\n", t: "\t", b: "\b" }) as Record<string, string>)[c] ?? c,
  );
}
export function parseGitmodules(content: string): Map<string, string> {
  const modules: { path?: string; url?: string }[] = [];
  let current: { path?: string; url?: string } | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) {
      current = /^\[submodule\s+"(?:[^"\\]|\\.)+"\]\s*(?:[;#].*)?$/.test(line)
        ? {}
        : undefined;
      if (current) modules.push(current);
      continue;
    }
    const pair = /^(path|url)\s*=\s*(.*)$/i.exec(line);
    if (current && pair)
      current[pair[1].toLowerCase() as "path" | "url"] = configValue(pair[2]);
  }
  const result = new Map<string, string>();
  for (const m of modules)
    if (m.path && m.url) {
      if (result.has(m.path))
        fail(422, "INVALID_GITMODULES", "중복된 서브모듈 경로가 있어요.");
      result.set(m.path, m.url);
    }
  return result;
}
export function repositoryRelations(
  value: unknown,
  urls: string[],
): RepositoryRelation[] {
  if (!Array.isArray(value) || value.length > 100)
    fail(
      400,
      "VALIDATION_ERROR",
      "서브모듈 관계는 최대 100개까지 저장할 수 있어요.",
    );
  const selected = new Set(urls.map((url) => url.toLowerCase()));
  const keys = new Set<string>();
  const parentCommits = new Map<string, string>();
  return (value as unknown[]).map((item) => {
    if (!item || typeof item !== "object")
      fail(400, "VALIDATION_ERROR", "서브모듈 관계를 확인해주세요.");
    const r = item as Record<string, unknown>;
    const [parentUrl, childUrl] = [
      projectRepositories([r.parentUrl])[0],
      projectRepositories([r.childUrl])[0],
    ];
    if (
      !selected.has(parentUrl.toLowerCase()) ||
      !selected.has(childUrl.toLowerCase()) ||
      parentUrl.toLowerCase() === childUrl.toLowerCase()
    )
      fail(400, "VALIDATION_ERROR", "부모와 하위 저장소를 함께 선택해주세요.");
    if (
      typeof r.path !== "string" ||
      !r.path ||
      r.path.length > 1024 ||
      r.path.startsWith("/") ||
      r.path.split("/").some((p) => !p || p === "." || p === "..") ||
      /[\x00-\x1f\\]/.test(r.path)
    )
      fail(400, "VALIDATION_ERROR", "서브모듈 경로를 확인해주세요.");
    if (
      ![r.commit, r.parentCommit].every(
        (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
      )
    )
      fail(400, "VALIDATION_ERROR", "서브모듈 참조 커밋을 확인해주세요.");
    const previous = parentCommits.get(parentUrl.toLowerCase());
    if (previous && previous !== r.parentCommit)
      fail(
        400,
        "VALIDATION_ERROR",
        "같은 상위 저장소의 참조 커밋은 일치해야 해요.",
      );
    parentCommits.set(parentUrl.toLowerCase(), r.parentCommit as string);
    const key = `${parentUrl.toLowerCase()}:${r.path}`;
    if (keys.has(key))
      fail(400, "VALIDATION_ERROR", "중복된 서브모듈 관계가 있어요.");
    keys.add(key);
    return {
      parentUrl,
      childUrl,
      path: r.path as string,
      commit: r.commit as string,
      parentCommit: r.parentCommit as string,
    };
  });
}
