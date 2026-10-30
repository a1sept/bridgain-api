import { createRequire } from "node:module";
import { limitedMemoryStorage } from "./requests.controller.js";
import type { Upload } from "./requests.service.js";
const multer = createRequire(import.meta.url)("multer");
import { fail } from "../auth/security.js";
import { TaskReviewService } from "./task-review.service.js";
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
    private readonly reviews: TaskReviewService,
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
    const user = await this.workspace.user(req, res, true);
    if (typeof b?.expectedVersion !== "string")
      fail(409, "TASK_VERSION_REQUIRED", "최신 업무를 다시 열어 저장해주세요.");
    return this.work.saveTask(user, pid, b, id);
  }
  @Get("tasks/:id/attachments") async taskFiles(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string) {
    return this.work.taskFiles(await this.workspace.user(req, res), pid, id);
  }
  @Post("tasks/:id/attachments") async uploadTaskFiles(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("projectId") pid: string, @Param("id") id: string) {
    const user = await this.workspace.user(req, res, true);
    await this.work.taskFiles(user, pid, id);
    await new Promise<void>((resolve, reject) => multer({storage: limitedMemoryStorage(20 * 1024 * 1024), limits: {fileSize: 20 * 1024 * 1024, files: 5, fields: 0, parts: 5}}).array("files", 5)(req, res, (error: unknown) => error ? reject(error) : resolve()))
      .catch(() => fail(400, "FILE_LIMIT", "PDF, PNG, JPG 최대 5개, 합계 20MB까지 첨부해주세요."));
    return this.work.taskFiles(user, pid, id, (req as Request & { files: Upload[] }).files);
  }
  @Get("tasks/:id/attachments/:fileId") async downloadTaskFile(@Req() req: Request, @Res() res: Response, @Param("projectId") pid: string, @Param("id") id: string, @Param("fileId") fileId: string) {
    const { file } = await this.work.taskFiles(await this.workspace.user(req, res), pid, id, undefined, fileId);
    res.setHeader("Content-Type", file!.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file!.name).replace(/'/g, "%27")}`);
    res.send(file!.content);
  }
  @Get("tasks/:id/result-entries") async resultEntries(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
  ) {
    return this.work.listResultEntries(
      await this.workspace.user(req, res),
      pid,
      id,
    );
  }
  @Post("tasks/:id/result-entries") async appendResult(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.work.appendResult(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
    );
  }
  @Get("tasks/:id/review") async reviewHistory(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
  ) {
    return this.reviews.history(await this.workspace.user(req, res), pid, id);
  }
  @Post("tasks/:id/review") async review(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.reviews.act(
      await this.workspace.user(req, res, true),
      pid,
      id,
      b,
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
  @Delete("meetings/:id") async deleteMeeting(
    @Req() req: Request, @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string, @Param("id") id: string,
  ) { return this.work.deleteMeeting(await this.workspace.user(req, res, true), pid, id); }
  @Post("meetings/:id/actions") async meetingAction(
    @Req() req:Request,@Res({passthrough:true}) res:Response,@Param("projectId") pid:string,@Param("id") id:string,@Body() b:Record<string,unknown>,
  ){return this.work.meetingAction(await this.workspace.user(req,res,true),pid,id,b);}
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
