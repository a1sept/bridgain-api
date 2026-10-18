import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { ProjectRolesService } from "./project-roles.service.js";
@Controller("workspace/projects/:projectId")
export class ProjectRolesController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly roles: ProjectRolesService,
  ) {}
  @Get("roles") async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.roles.list(await this.workspace.user(req, res), pid);
  }
  @Post("roles") async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.roles.save(
      await this.workspace.user(req, res, true),
      pid,
      undefined,
      body,
    );
  }
  @Patch("roles/:roleId") async update(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("roleId") rid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.roles.save(
      await this.workspace.user(req, res, true),
      pid,
      rid,
      body,
    );
  }
  @Delete("roles/:roleId") async remove(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("roleId") rid: string,
  ) {
    return this.roles.remove(
      await this.workspace.user(req, res, true),
      pid,
      rid,
    );
  }
  @Patch("member-roles/:userId") async assign(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("userId") uid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.roles.assign(
      await this.workspace.user(req, res, true),
      pid,
      uid,
      body,
    );
  }
}
