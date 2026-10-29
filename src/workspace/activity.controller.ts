import { Controller, Get, Query, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { ActivityService } from "./activity.service.js";
@Controller("workspace/activity")
export class ActivityController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly activity: ActivityService,
  ) {}
  @Get("options") async options(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() q: Record<string, unknown>,
  ) {
    return this.activity.options(await this.workspace.user(req, res), q);
  }
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() q: Record<string, unknown>,
  ) {
    return this.activity.list(await this.workspace.user(req, res), q);
  }
  @Get(":id") async detail(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("id") id: string,
  ) {
    return this.activity.detail(await this.workspace.user(req, res), id);
  }
}
