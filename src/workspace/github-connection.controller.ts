import { randomBytes } from "node:crypto";
import { Body, Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { GithubConnectionService } from "./github-connection.service.js";
import { fail } from "../auth/security.js";
@Controller("workspace/github")
export class GithubConnectionController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly github: GithubConnectionService,
  ) {}
  private async user(req: Request, res: Response, mutation = false) {
    const user = await this.workspace.user(req, res, mutation);
    if (
      req.get("x-bridgain-app") !== "developer" ||
      user.accountType !== "team"
    )
      fail(403, "GITHUB_TEAM_REQUIRED", "개발자 팀 계정으로 연결해주세요.");
    return user;
  }
  @Get("status") async status(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.github.status((await this.user(req, res)).id);
  }
  @Post("desktop-connect") async desktopConnect(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return this.github.desktopConnect((await this.user(req, res, true)).id);
  }
  @Post("desktop-complete") async desktopComplete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { state?: unknown; claimSecret?: unknown; confirm?: unknown },
  ) {
    const user = await this.user(req, res, true);
    res.setHeader("Cache-Control", "no-store");
    return this.github.desktopComplete(user.id, body?.state, body?.claimSecret, body?.confirm === true);
  }
  @Post("desktop-cancel") async desktopCancel(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { state?: unknown; claimSecret?: unknown },
  ) {
    const user = await this.user(req, res, true);
    return this.github.desktopCancel(user.id, body?.state, body?.claimSecret);
  }
  @Post("connect") async connect(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { expectedUserId?: unknown },
  ) {
    const user = await this.user(req, res, true);
    if (body?.expectedUserId !== undefined && body.expectedUserId !== user.id)
      fail(
        409,
        "GITHUB_ACCOUNT_MISMATCH",
        "데스크톱 앱과 동일한 Bridgain 계정으로 다시 로그인해주세요.",
      );
    return this.github.connect(user.id);
  }
  @Get("callback") async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("state") state: unknown,
    @Query("code") code: unknown,
    @Query("error") error?: unknown,
  ) {
    if (typeof state === "string" && state.startsWith("desktop.")) {
      const result = await this.github.desktopCallback(state, code, error);
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      return res.type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>GitHub 인증 확인</title></head><body><h1>${result.authorized ? "GitHub 인증을 확인했어요" : "GitHub 인증이 완료되지 않았어요"}</h1><p>${result.authorized ? "Bridgain 데스크톱 앱으로 돌아가 연결할 계정을 확인해주세요. 아직 계정 연결은 완료되지 않았어요." : "Bridgain 데스크톱 앱에서 다시 연결해주세요."}</p></body></html>`);
    }
    const user = await this.user(req, res);
    await this.github.callback(user.id, state, code);
    const installationUrl = await this.github.installationUrlIfNeeded(user.id);
    if (installationUrl) return res.redirect(installationUrl);
    return this.completion(res);
  }
  @Get("callback/complete") async complete(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = await this.user(req, res);
    const installationUrl = await this.github.installationUrlIfNeeded(user.id);
    if (installationUrl) return res.redirect(installationUrl);
    return this.completion(res);
  }
  private completion(res: Response) {
    const nonce = randomBytes(24).toString("base64");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    return res.type("html").send(
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub 연결 완료</title>
<style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10151d;color:#e8edf5;font:16px system-ui,sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:24px}p{line-height:1.7;color:#b5c0cf}button{padding:12px 24px;border:0;border-radius:8px;background:#536dfe;color:white;font:inherit;cursor:pointer}</style></head>
<body><main><h1>GitHub 연결 완료</h1><p>프로젝트 화면에 저장소 목록을 불러오고 있어요.<br>창이 자동으로 닫히지 않으면 아래 버튼으로 닫아주세요.</p><button id="close" type="button">프로젝트 화면으로 돌아가기</button></main>
<script nonce="${nonce}">
function finish() {
  try { const channel = new BroadcastChannel('bridgain-github'); channel.postMessage({ type: 'connected' }); channel.close(); } catch {}
  window.close();
}
document.getElementById('close').addEventListener('click', finish);
finish();
</script></body></html>`,
    );
  }
  @Get("submodules") async submodules(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query("repositoryUrl") repositoryUrl: unknown,
  ) {
    return this.github.submodules(
      (await this.user(req, res)).id,
      repositoryUrl,
    );
  }
  @Get("repositories") async repositories(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return {
      repositories: await this.github.repositories(
        (await this.user(req, res)).id,
      ),
    };
  }
  @Post("disconnect") async disconnect(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.github.disconnect((await this.user(req, res, true)).id);
  }
}
