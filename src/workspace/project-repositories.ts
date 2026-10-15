import { fail } from "../auth/security.js";

// Registration is metadata only; it never grants GitHub or merge-token access.
export function projectRepositories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20)
    fail(400, "VALIDATION_ERROR", "GitHub 저장소는 최대 20개까지 등록해주세요.");
  const urls = (value as unknown[]).map((item) => {
    if (typeof item !== "string" || item.length > 300)
      fail(400, "VALIDATION_ERROR", "GitHub 저장소 URL을 확인해주세요.");
    const match = /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9_.-]{1,100})\/?$/i.exec((item as string).trim());
    const repo = match?.[2].replace(/\.git$/i, "");
    if (!match || !repo || /^\.+$/.test(repo))
      fail(400, "VALIDATION_ERROR", "https://github.com/소유자/저장소 형식으로 입력해주세요.");
    return `https://github.com/${match![1]}/${repo}`;
  });
  if (new Set(urls.map((url) => url.toLowerCase())).size !== urls.length)
    fail(400, "VALIDATION_ERROR", "같은 GitHub 저장소가 중복되었습니다.");
  return urls;
}
