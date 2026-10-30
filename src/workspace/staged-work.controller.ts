import { Controller, Get, Post, Param, Body, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { StagedWorkService } from "./staged-work.service.js";
@Controller("workspace/projects/:projectId")
export class StagedWorkController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly work: StagedWorkService,
  ) {}
  @Get("tasks/:id/git/context") async gitContext(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string) {
    return this.work.gitContext(await this.workspace.user(req, res), pid, id);
  }
  @Post("tasks/:id/git/context") async gitWriteContext(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string) {
    return this.work.gitContext(await this.workspace.user(req, res, true), pid, id, true);
  }
  @Post("tasks/:id/git/submit") async submitPr(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.work.submitPr(await this.workspace.user(req, res, true), pid, id, body);
  }
  @Get("tasks/:id/git/code") async remoteCode(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string) {
    return this.work.remoteCode(await this.workspace.user(req, res), pid, id);
  }
  @Get("tasks/:id/work") async history(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
  ) {
    return this.work.history(await this.workspace.user(req, res), pid, id);
  }
  @Post("tasks/:id/work") async act(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.work.act(
      await this.workspace.user(req, res, true),
      pid,
      id,
      body,
    );
  }
  @Get("deployments") async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.work.deployments(await this.workspace.user(req, res), pid);
  }
  @Post("deployments") async deploy(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.work.deploy(
      await this.workspace.user(req, res, true),
      pid,
      body,
    );
  }
  @Post("tasks/:id/deployment") async deployed(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.work.deployed(
      await this.workspace.user(req, res, true),
      pid,
      id,
      body,
    );
  }
}
