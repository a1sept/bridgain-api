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
import { ApprovalService } from "./approval.service.js";
@Controller("workspace")
export class ApprovalController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly approvals: ApprovalService,
  ) {}
  @Get("approvals") async inbox(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.approvals.list(await this.workspace.user(req, res));
  }
  @Get("projects/:pid/approvals") async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("pid") pid: string,
  ) {
    return this.approvals.list(await this.workspace.user(req, res), pid);
  }
  @Post("projects/:pid/approvals") async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("pid") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.approvals.create(
      await this.workspace.user(req, res, true),
      pid,
      b,
    );
  }
  @Post("projects/:pid/approvals/:id/actions") async act(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.approvals.act(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
    );
  }
  @Patch("projects/:pid/members/:id") async delegate(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.approvals.delegate(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
    );
  }
}
