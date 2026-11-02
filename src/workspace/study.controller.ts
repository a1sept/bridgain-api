import { StudyEventsService } from "./study-events.service.js";
import { StudyLiveService } from "./study-live.service.js";
import { StudyDecksService } from "./study-decks.service.js";
import { StudyAssetsService } from "./study-assets.service.js";
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { StudyService } from "./study.service.js";
@Controller("workspace/projects/:pid/study")
export class StudyController {
  constructor(
    private readonly auth: WorkspaceController,
    private readonly study: StudyService,
    private readonly assets: StudyAssetsService,
    private readonly decks: StudyDecksService,
    private readonly live: StudyLiveService,
    private readonly events: StudyEventsService,
  ) {}
  @Get() async get(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
  ) {
    return this.study.snapshot(await this.auth.user(r, s), pid, {
      programId:
        typeof r.query.programId === "string" ? r.query.programId : undefined,
      sessionCursor:
        typeof r.query.sessionCursor === "string"
          ? r.query.sessionCursor
          : undefined,
      activityCursor:
        typeof r.query.activityCursor === "string"
          ? r.query.activityCursor
          : undefined,
    });
  }
  @Post("programs") async create(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.createProgram(await this.auth.user(r, s, true), pid, b);
  }
  @Patch("programs/:id") async update(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.updateProgram(
      await this.auth.user(r, s, true),
      pid,
      id,
      b,
    );
  }
  @Post("programs/:id/sessions") async session(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.saveSession(await this.auth.user(r, s, true), pid, id, b);
  }
  @Patch("programs/:id/sessions/:sid") async editSession(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Param("sid") sid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.saveSession(
      await this.auth.user(r, s, true),
      pid,
      id,
      b,
      sid,
    );
  }
  @Patch("members/:id/deputy") async deputy(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.setDeputy(await this.auth.user(r, s, true), pid, id, b);
  }
  @Post("roles") async role(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.saveRole(await this.auth.user(r, s, true), pid, b);
  }
  @Patch("roles/:id") async editRole(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.saveRole(await this.auth.user(r, s, true), pid, b, id);
  }
  @Patch("members/:id/roles") async assign(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.assignRoles(await this.auth.user(r, s, true), pid, id, b);
  }

  @Post("programs/:id/activities") async activity(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.createActivity(
      await this.auth.user(r, s, true),
      pid,
      id,
      b,
    );
  }
  @Get("activities/:id") async activityDetail(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    return this.study.activityDetail(await this.auth.user(r, s), pid, id);
  }
  @Post("activities/:id/submissions") async submit(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.submit(await this.auth.user(r, s, true), pid, id, b);
  }

  @Post("assets") async upload(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
  ) {
    const u = await this.auth.user(r, s, true);
    let name: string;
    try {
      name = decodeURIComponent(r.get("x-file-name") ?? "");
    } catch {
      throw new Error("파일 이름을 확인해주세요.");
    }
    return this.assets.upload(
      u,
      pid,
      name,
      (r.get("content-type") ?? "").split(";")[0],
      r,
    );
  }
  @Get("assets/:id") async asset(
    @Req() r: Request,
    @Res() s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    const asset = await this.assets.read(
      await this.auth.user(r, s),
      pid,
      id,
      r.query.preview === "thumbnail" ? "thumbnail" : r.query.preview === "1",
      r.get("range"),
    );
    s.setHeader("Content-Type", asset.mime);
    s.setHeader("Accept-Ranges", "bytes");
    s.setHeader("Content-Length", String(asset.length));
    s.setHeader("Cache-Control", "private, no-store");
    if (asset.contentRange) {
      s.status(206);
      s.setHeader("Content-Range", asset.contentRange);
    }
    s.setHeader("X-Content-Type-Options", "nosniff");
    s.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    );
    asset.stream.on("error", () => s.destroy());
    asset.stream.pipe(s);
  }

  @Get("programs/:programId/decks") async decksList(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
  ) {
    return this.decks.list(await this.auth.user(r, s), pid, programId);
  }
  @Post("programs/:programId/decks") async deckCreate(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.decks.create(
      await this.auth.user(r, s, true),
      pid,
      programId,
      b,
    );
  }
  @Get("programs/:programId/decks/:id") async deckGet(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Param("id") id: string,
  ) {
    return this.decks.get(await this.auth.user(r, s), pid, programId, id);
  }
  @Patch("programs/:programId/decks/:id") async deckUpdate(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.decks.update(
      await this.auth.user(r, s, true),
      pid,
      programId,
      id,
      b,
    );
  }
  @Get("programs/:programId/decks/:id/history") async history(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Param("id") id: string,
  ) {
    return this.decks.history(
      await this.auth.user(r, s),
      pid,
      programId,
      id,
      typeof r.query.cursor === "string" ? r.query.cursor : undefined,
    );
  }
  @Post("programs/:programId/decks/:id/configure") async deckConfigure(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.decks.configure(
      await this.auth.user(r, s, true),
      pid,
      programId,
      id,
      b,
    );
  }

  @Post("programs/:programId/decks/:id/presence") async presence(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("programId") programId: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.decks.heartbeat(
      await this.auth.user(r, s, true),
      pid,
      programId,
      id,
      b,
    );
  }
  @Get("settings") async settingsGet(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
  ) {
    return this.live.settings(await this.auth.user(r, s), pid);
  }
  @Patch("settings") async settingsSave(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.live.settings(await this.auth.user(r, s, true), pid, b);
  }
  @Post("sessions/:id/live") async liveCommand(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.live.command(await this.auth.user(r, s, true), pid, id, b);
  }
  @Get("sessions/:id/attendance") async attendanceGet(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    return this.live.attendance(await this.auth.user(r, s), pid, id);
  }

  @Get("sessions/:id/materials") async liveMaterials(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    return this.live.materials(
      await this.auth.user(r, s),
      pid,
      id,
      typeof r.query.sessionId === "string" ? r.query.sessionId : undefined,
    );
  }
  @Post("members/:id/remove") async removeMember(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    return this.study.removeMember(await this.auth.user(r, s, true), pid, id);
  }

  @Get("sessions/:id/events") async liveEvents(
    @Req() r: Request,
    @Res() s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
  ) {
    const u = await this.auth.user(r, s),
      connectionId = String(r.query.connectionId ?? "");
    const first = await this.live.liveSnapshot(u, pid, id, connectionId);
    s.setHeader("Content-Type", "text/event-stream");
    s.setHeader("Cache-Control", "no-cache, no-transform");
    s.setHeader("X-Accel-Buffering", "no");
    s.flushHeaders();
    let closed = false,
      running = false,
      again = false;
    const send = (data: unknown) => {
      if (!closed) s.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send(first);
    const refresh = async () => {
      if (closed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const currentUser = await this.auth.user(r, s);
          send(
            await this.live.liveSnapshot(currentUser, pid, id, connectionId),
          );
        } while (again && !closed);
      } catch {
        if (!closed) {
          s.write("event: closed\ndata: {}\n\n");
          s.end();
        }
      } finally {
        running = false;
      }
    };
    const unsubscribe = this.events.subscribe(pid, () => {
      void refresh();
    });
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    s.on("close", () => {
      closed = true;
      unsubscribe();
      clearInterval(timer);
    });
  }

  @Post("sessions/:id/attendance/:userId") async correctAttendance(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Param("userId") userId: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.live.correctAttendance(
      await this.auth.user(r, s, true),
      pid,
      id,
      userId,
      b,
    );
  }
  @Get("storage") async storage(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
  ) {
    return this.assets.storage(await this.auth.user(r, s), pid);
  }

  @Patch("programs/:id/organizers") async organizers(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.setOrganizers(
      await this.auth.user(r, s, true),
      pid,
      id,
      b,
    );
  }
  @Patch("programs/:id/activities/:activityId") async editActivity(
    @Req() r: Request,
    @Res({ passthrough: true }) s: Response,
    @Param("pid") pid: string,
    @Param("id") id: string,
    @Param("activityId") activityId: string,
    @Body() b: Record<string, unknown>,
  ) {
    return this.study.createActivity(
      await this.auth.user(r, s, true),
      pid,
      id,
      b,
      activityId,
    );
  }
}
