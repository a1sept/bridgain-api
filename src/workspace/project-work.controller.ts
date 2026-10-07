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
import { ProjectWorkService } from "./project-work.service.js";
@Controller("workspace/projects/:projectId")
export class ProjectWorkController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly work: ProjectWorkService,
  ) {}
  @Get("tasks") async tasks(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.work.listTasks(await this.workspace.user(req, res), pid);
  }
  @Post("tasks") async createTask(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveTask(
      await this.workspace.user(req, res, true),
      pid,
      b,
    );
  }
  @Patch("tasks/:id") async updateTask(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveTask(
      await this.workspace.user(req, res, true),
      pid,
      b,
      id,
    );
  }
  @Get("meetings") async meetings(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.work.listMeetings(await this.workspace.user(req, res), pid);
  }
  @Post("meetings") async createMeeting(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveMeeting(
      await this.workspace.user(req, res, true),
      pid,
      b,
    );
  }
  @Patch("meetings/:id") async updateMeeting(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveMeeting(
      await this.workspace.user(req, res, true),
      pid,
      b,
      id,
    );
  }
  @Get("documents") async documents(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.work.listDocuments(await this.workspace.user(req, res), pid);
  }
  @Post("documents") async createDocument(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveDocument(
      await this.workspace.user(req, res, true),
      pid,
      b,
    );
  }
  @Patch("documents/:id") async updateDocument(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.saveDocument(
      await this.workspace.user(req, res, true),
      pid,
      b,
      id,
    );
  }
  @Get("activity") async activity(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.work.listActivity(await this.workspace.user(req, res), pid);
  }
}
