import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { AiService } from "./ai.service.js";
@Controller("workspace/projects/:projectId/ai/sessions")
export class AiController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly ai: AiService,
  ) {}
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.ai.list(await this.workspace.user(req, res), pid);
  }
  @Post() async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.ai.create(await this.workspace.user(req, res, true), pid, b);
  }
  @Get(":id") async detail(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
  ) {
    return this.ai.detail(await this.workspace.user(req, res), pid, id);
  }
  @Patch(":id") async update(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.ai.update(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
    );
  }
  @Post(":id/messages") async message(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.ai.message(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
    );
  }
  @Post(":id/tools") async tool(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.ai.tool(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b.name,
      b.arguments,
    );
  }
  @Post(":id/drafts/:draftId/apply") async apply(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Param("draftId") did: string,
  ) {
    return this.ai.apply(
      await this.workspace.user(req, res, true),
      pid,
      id,
      did,
    );
  }
}
