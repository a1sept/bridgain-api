import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { ChannelService } from "./channel.service.js";
@Controller("workspace/projects/:projectId/channel")
export class ChannelController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly channel: ChannelService,
  ) {}
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Query("parent") parent?: string,
    @Query("task") task?: string,
    @Query("before") before?: string,
  ) {
    return this.channel.list(
      await this.workspace.user(req, res),
      pid,
      parent,
      task,
      before,
    );
  }
  @Post() async post(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.channel.post(
      await this.workspace.user(req, res, true),
      pid,
      body,
    );
  }
}
