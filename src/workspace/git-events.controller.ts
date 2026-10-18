import { StagedWorkService } from "./staged-work.service.js";
import { TaskReviewService } from "./task-review.service.js";
import { Controller, Post, Req, Headers, RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ProjectWorkService } from "./project-work.service.js";
import { fail } from "../auth/security.js";
export function verifyGitEvent(
  body: Buffer | undefined,
  signature: string | undefined,
  secret: string | undefined,
) {
  if (!secret || secret.length < 32)
    fail(503, "INTEGRATION_DISABLED", "Git 연동이 설정되지 않았습니다.");
  if (!body || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    fail(403, "INVALID_SIGNATURE", "서명을 확인해주세요.");
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret!).update(body!).digest("hex")}`,
  );
  const actual = Buffer.from(signature!);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail(403, "INVALID_SIGNATURE", "서명을 확인해주세요.");
}
export type GitEvent = {
  repository: string;
  kind: "merge" | "deployment";
  branch: string;
  workBranch?: string;
  headSha?: string;
  commit: string;
  url: string;
  includedCommits?: string[];
};
export function parseGitEvent(
  event: string,
  payload: Record<string, any>,
  environment: string,
): GitEvent | null {
  const repository = payload?.repository?.html_url;
  if (
    typeof repository !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      repository,
    )
  )
    return null;
  if (
    event === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged === true
  ) {
    const pr = payload.pull_request;
    if (
      pr.base?.repo?.html_url !== repository ||
      typeof pr.head?.ref !== "string" ||
      typeof pr.base?.ref !== "string" ||
      typeof pr.merge_commit_sha !== "string" ||
      typeof pr.html_url !== "string"
    )
      return null;
    // Fork branches cannot be identified by branch name alone.
    if (pr.head?.repo?.html_url !== repository) return null;
    return {
      repository,
      kind: "merge",
      branch: pr.base.ref,
      workBranch: pr.head.ref,
      ...(typeof pr.head.sha === "string" ? { headSha: pr.head.sha } : {}),
      commit: pr.merge_commit_sha,
      url: pr.html_url,
    };
  }
  if (
    event === "deployment_status" &&
    payload.deployment_status?.state === "success" &&
    payload.deployment?.environment === environment
  ) {
    const deployment = payload.deployment;
    const url =
      payload.deployment_status.target_url ||
      payload.deployment_status.environment_url;
    if (
      typeof deployment.ref !== "string" ||
      typeof deployment.sha !== "string" ||
      typeof url !== "string"
    )
      return null;
    const included = deployment.payload?.included_commits;
    const includedCommits =
      Array.isArray(included) &&
      included.length <= 500 &&
      included.every((c) => typeof c === "string" && /^[a-f0-9]{40}$/i.test(c))
        ? included
        : [];
    return {
      repository,
      kind: "deployment",
      branch: deployment.ref,
      commit: deployment.sha,
      url,
      includedCommits,
    };
  }
  return null;
}
@Controller("integrations/github")
export class GitEventsController {
  constructor(
    private readonly work: ProjectWorkService,
    private readonly reviews: TaskReviewService,
    private readonly staged: StagedWorkService,
  ) {}
  @Post() async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string,
    @Headers("x-github-event") event: string,
  ) {
    verifyGitEvent(req.rawBody, signature, process.env.GITHUB_WEBHOOK_SECRET);
    if (event === "pull_request" && req.body?.pull_request?.merged !== true) {
      const staged = await this.staged.syncPullRequest(req.body);
      const legacy = await this.reviews.syncPullRequest(req.body);
      return { updated: staged.updated + legacy.updated };
    }
    const parsed = parseGitEvent(
      event,
      req.body,
      process.env.GITHUB_DEPLOYMENT_ENVIRONMENT || "production",
    );
    if (!parsed) return { updated: 0, ignored: true };
    const staged = await this.staged.applyGitEvent(parsed);
    const legacy = await this.work.applyGitEvent(parsed);
    return { updated: staged.updated + legacy.updated };
  }
}
