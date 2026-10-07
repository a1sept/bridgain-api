import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "../auth/auth.service.js";
import { AppKind, cookies, equal, fail } from "../auth/security.js";
import { WorkspaceService } from "./workspace.service.js";
@Controller("workspace")
export class WorkspaceController {
  constructor(
    private readonly auth: AuthService,
    private readonly workspace: WorkspaceService,
  ) {}
  async user(req: Request, res: Response, mutation = false) {
    const secret = process.env.AUTH_PROXY_SECRET;
    const app = req.get("x-bridgain-app") as AppKind;
    if (
      !secret ||
      secret.length < 32 ||
      !equal(req.get("x-bridgain-proxy-secret") ?? "", secret) ||
      !["client", "developer"].includes(app)
    )
      fail(403, "PROXY_REQUIRED", "허용된 앱을 통해 접속해주세요.");
    const jar = cookies(req.get("cookie"));
    if (mutation) {
      const csrf = jar[`bridgain_${app}_csrf`];
      if (
        req.get("origin") !== this.auth.origin(app) ||
        !csrf ||
        !/^[a-f0-9]{64}$/.test(csrf) ||
        !equal(csrf, req.get("x-csrf-token") ?? "")
      )
        fail(403, "CSRF_INVALID", "새로고침 후 다시 시도해주세요.");
    }
    res.setHeader("Cache-Control", "no-store");
    return (await this.auth.me(app, jar[`bridgain_${app}_session`])).user;
  }
  @Get() async get(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.workspace.snapshot(await this.user(req, res));
  }
  @Get("users") async searchUsers(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query("q") query: unknown,
    @Query("accountType") accountType: unknown,
  ) {
    return this.workspace.searchUsers(
      await this.user(req, res),
      query,
      accountType,
    );
  }
  @Get("users/:id") async lookup(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
  ) {
    return this.workspace.lookup(await this.user(req, res), id);
  }
  @Post("projects") async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workspace.create(await this.user(req, res, true), body);
  }
  @Patch("projects/:id") async update(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workspace.update(await this.user(req, res, true), id, body);
  }
  @Post("projects/:id/invitations") async invite(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workspace.invite(await this.user(req, res, true), id, body);
  }
  @Post("invitations/:id/respond") async respond(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workspace.respond(await this.user(req, res, true), id, body);
  }
  @Patch("teams/:teamId/members/:userId") async member(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("teamId") teamId: string,
    @Param("userId") userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.workspace.member(
      await this.user(req, res, true),
      teamId,
      userId,
      body,
    );
  }
}
