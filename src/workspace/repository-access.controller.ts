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
import { RepositoryAccessService } from "./repository-access.service.js";
@Controller("workspace/projects/:projectId/repository-access")
export class RepositoryAccessController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly service: RepositoryAccessService,
  ) {}
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.service.list(await this.workspace.user(req, res), pid);
  }
  @Post("requests") async request(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.request(
      await this.workspace.user(req, res, true),
      pid,
      body,
    );
  }
  @Patch("requests/:id") async resolve(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.resolve(
      await this.workspace.user(req, res, true),
      pid,
      id,
      body,
    );
  }
}
