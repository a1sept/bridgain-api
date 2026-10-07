import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Readable } from "node:stream";
import { createRequire } from "node:module";
import { WorkspaceController } from "./workspace.controller.js";
import { RequestsService, type Upload } from "./requests.service.js";
import { fail } from "../auth/security.js";
const require = createRequire(import.meta.url);
const multer = require("multer") as (options: unknown) => {
  array: (
    name: string,
    count: number,
  ) => (req: Request, res: Response, cb: (error?: unknown) => void) => void;
};
// Per-upload shared budget stops buffering before the combined limit is exceeded.
function limitedMemoryStorage(limit: number) {
  let total = 0;
  return {
    _handleFile(
      _req: Request,
      file: { stream: Readable },
      done: (
        error: Error | null,
        info?: { buffer: Buffer; size: number },
      ) => void,
    ) {
      let chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const finish = (error: Error | null) => {
        if (finished) return;
        finished = true;
        if (error) {
          chunks = [];
          done(error);
        } else done(null, { buffer: Buffer.concat(chunks), size });
      };
      file.stream.on("data", (chunk: Buffer) => {
        if (finished) return;
        total += chunk.length;
        if (total > limit) {
          finish(new Error("FILE_LIMIT"));
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      file.stream.on("error", (error: Error) => finish(error));
      file.stream.on("end", () => finish(null));
    },
    _removeFile(
      _req: Request,
      file: { buffer?: Buffer },
      done: (error: Error | null) => void,
    ) {
      delete file.buffer;
      done(null);
    },
  };
}
@Controller("workspace/projects/:projectId/requests")
export class RequestsController {
  constructor(
    private readonly workspace: WorkspaceController,
    private readonly requests: RequestsService,
  ) {}
  @Get() async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
  ) {
    return this.requests.list(await this.workspace.user(req, res), pid);
  }
  @Post() async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.requests.create(
      await this.workspace.user(req, res, true),
      pid,
      body,
    );
  }
  @Get(":requestId") async detail(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("requestId") rid: string,
  ) {
    return this.requests.detail(await this.workspace.user(req, res), pid, rid);
  }
  @Patch(":requestId") async update(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("requestId") rid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.requests.update(
      await this.workspace.user(req, res, true),
      pid,
      rid,
      body,
    );
  }
  @Post(":requestId/comments") async comment(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("requestId") rid: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.requests.comment(
      await this.workspace.user(req, res, true),
      pid,
      rid,
      body,
    );
  }
  @Post(":requestId/attachments") async upload(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("projectId") pid: string,
    @Param("requestId") rid: string,
  ) {
    const u = await this.workspace.user(req, res, true);
    const detail = await this.requests.detail(u, pid, rid);
    if (!detail.canUpload)
      fail(403, "FORBIDDEN", "작성자와 개발팀만 첨부할 수 있습니다.");
    await new Promise<void>((resolve, reject) =>
      multer({
        storage: limitedMemoryStorage(
          20 * 1024 * 1024 -
            detail.attachments.reduce((sum, file) => sum + file.size, 0),
        ),
        limits: { fileSize: 20 * 1024 * 1024, files: 5, fields: 0, parts: 5 },
      }).array("files", 5)(req, res, (error) =>
        error ? reject(error) : resolve(),
      ),
    ).catch(() =>
      fail(
        400,
        "FILE_LIMIT",
        "첨부는 PDF, PNG, JPG 최대 5개, 합계 20MB까지 가능합니다.",
      ),
    );
    return this.requests.upload(
      u,
      pid,
      rid,
      (req as Request & { files: Upload[] }).files,
    );
  }
  @Get(":requestId/attachments/:attachmentId") async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param("projectId") pid: string,
    @Param("requestId") rid: string,
    @Param("attachmentId") fid: string,
  ) {
    const file = await this.requests.download(
      await this.workspace.user(req, res),
      pid,
      rid,
      fid,
    );
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
    );
    res.send(file.content);
  }
}
