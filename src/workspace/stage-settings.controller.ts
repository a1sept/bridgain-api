import { Body, Controller, Get, Post, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { StageSettingsService } from "./stage-settings.service.js";
@Controller("workspace/projects/:projectId/stage-settings")
export class StageSettingsController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly settings: StageSettingsService,
  ) {}
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.settings.list(await this.workspace.user(req, res), pid);
  }
  @Post() async save(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.settings.save(
      await this.workspace.user(req, res, true),
      pid,
      b,
    );
  }
}
