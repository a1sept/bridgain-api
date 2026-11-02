import { Injectable, Logger } from "@nestjs/common";
import { and, eq, sql, isNull, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { mkdir, rm, open, stat } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { DatabaseService } from "../db/database.service.js";
import { projects } from "../db/schema/workspace.js";
import {
  studyAssets as assets,
  studyDeckAssets as deckAssets,
  studyDecks as decks,
  studyProgramMembers as programMembers,
  studyLiveRooms as liveRooms,
  studyLiveConnections as liveConnections,
  studySessions as sessions,
  studyPrograms as programs,
  studySubmissionAssets as links,
  studySubmissionVersions as versions,
  studyActivities as activities,
  studyOrganizers as hosts,
} from "../db/schema/study.js";
import { resolveProjectPermissions } from "./project-roles.service.js";
import { bounded, uuid } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; accountType: string };
const types: Record<string, { ext: string; limit: number }> = {
  "image/png": { ext: "png", limit: 20 * 1024 ** 2 },
  "image/jpeg": { ext: "jpg", limit: 20 * 1024 ** 2 },
  "image/webp": { ext: "webp", limit: 20 * 1024 ** 2 },
  "application/pdf": { ext: "pdf", limit: 100 * 1024 ** 2 },
  "video/mp4": { ext: "mp4", limit: 1024 ** 3 },
  "video/webm": { ext: "webm", limit: 1024 ** 3 },
};
export function studyFileType(mime: string, head: Buffer) {
  return mime === "image/png"
    ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/jpeg"
      ? head[0] === 255 && head[1] === 216 && head[2] === 255
      : mime === "image/webp"
        ? head.toString("ascii", 0, 4) === "RIFF" &&
          head.toString("ascii", 8, 12) === "WEBP"
        : mime === "application/pdf"
          ? head.toString("ascii", 0, 5) === "%PDF-"
          : mime === "video/mp4"
            ? head.toString("ascii", 4, 8) === "ftyp"
            : mime === "video/webm"
              ? head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
              : false;
}
@Injectable()
export class StudyAssetsService {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private cleaning = false;
  private readonly logger = new Logger(StudyAssetsService.name);
  constructor(private readonly database: DatabaseService) {}
  onModuleInit() {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupUnused().catch(() =>
        this.logger.warn("Unused study upload cleanup failed; will retry."),
      );
    }, 3600000);
    this.cleanupTimer.unref();
  }
  onModuleDestroy() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
  async storage(u: User, pid: string) {
    await this.access(u, pid);
    const result = await this.database.db.execute(
      sql`SELECT COALESCE(SUM(storage_bytes),0) AS bytes FROM study_assets WHERE project_id=${pid}`,
    );
    return {
      usedBytes: Number(result.rows[0]?.bytes ?? 0),
      limitBytes: 10 * 1024 ** 3,
      unusedRetentionDays: 7,
    };
  }
  async cleanupUnused(now = new Date()) {
    if (this.cleaning) return { removed: 0 };
    this.cleaning = true;
    let removed = 0;
    try {
      const candidates = await this.database.db
        .select()
        .from(assets)
        .where(
          sql`${assets.lastUsedAt}<${new Date(+now - 7 * 86400000)} AND NOT EXISTS(SELECT 1 FROM study_submission_assets r WHERE r.asset_id=${assets.id}) AND NOT EXISTS(SELECT 1 FROM study_deck_assets r WHERE r.asset_id=${assets.id}) AND NOT EXISTS(SELECT 1 FROM study_live_rooms r WHERE r.shared::jsonb->'asset'->>'id'=${assets.id}::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r.shared::jsonb->'elements','[]'::jsonb)) e WHERE e->>'assetId'=${assets.id}::text))`,
        )
        .limit(100);
      for (const candidate of candidates) {
        await this.database.db.transaction(async (tx) => {
          await tx
            .select()
            .from(projects)
            .where(eq(projects.id, candidate.projectId))
            .for("update");
          const [current] = await tx
            .select()
            .from(assets)
            .where(eq(assets.id, candidate.id));
          if (!current || +current.lastUsedAt >= +now - 7 * 86400000) return;
          const references = await tx.execute(
            sql`SELECT 1 FROM study_submission_assets WHERE asset_id=${current.id} UNION ALL SELECT 1 FROM study_deck_assets WHERE asset_id=${current.id} UNION ALL SELECT 1 FROM study_live_rooms WHERE shared::jsonb->'asset'->>'id'=${current.id} OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(shared::jsonb->'elements','[]'::jsonb)) e WHERE e->>'assetId'=${current.id}) LIMIT 1`,
          );
          if (references.rows.length) return;
          const directory = dirname(
            dirname(join(this.root(), current.storageKey)),
          );
          await rm(directory, { recursive: true, force: true });
          await tx.delete(assets).where(eq(assets.id, current.id));
          removed++;
        });
      }
      return { removed };
    } finally {
      this.cleaning = false;
    }
  }
  private root() {
    return resolve(
      process.env.STUDY_ASSET_ROOT ?? "/home/a1sept/bridgain/study-assets",
    );
  }
  private async access(u: User, pid: string) {
    return this.database.db.transaction(async (tx) => {
      const a = await resolveProjectPermissions(tx, u, uuid(pid));
      if (a.kind !== "study")
        fail(404, "NOT_FOUND", "스터디를 찾을 수 없습니다.");
      return a;
    });
  }
  async upload(
    u: User,
    pid: string,
    name: string,
    mime: string,
    input: Readable,
  ) {
    await this.access(u, pid);
    const type = types[mime];
    if (!type)
      fail(400, "FILE_TYPE", "이미지, PDF, MP4 또는 WebM 파일을 선택해주세요.");
    name = bounded(name.replace(/[\\/\x00-\x1f\x7f]/g, "_"), 200);
    const id = randomUUID();
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const key = join(
      parts.find((p) => p.type === "year")!.value,
      parts.find((p) => p.type === "month")!.value,
      pid,
      id,
    );
    const directory = join(this.root(), key);
    await mkdir(join(directory, "original"), { recursive: true });
    const storageKey = join(key, "original", `source.${type.ext}`),
      path = join(this.root(), storageKey);
    let size = 0;
    let previewKey: string | null = null;
    let thumbnailKey: string | null = null;
    try {
      await pipeline(
        input,
        new Transform({
          transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > type.limit)
              callback(new Error("파일 크기 제한을 초과했습니다."));
            else callback(null, chunk);
          },
        }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      const file = await open(path, "r");
      const head = Buffer.alloc(16);
      try {
        await file.read(head, 0, 16, 0);
      } finally {
        await file.close();
      }
      if (!studyFileType(mime, head))
        fail(400, "FILE_TYPE", "파일 형식과 내용이 일치하지 않습니다.");
      if (mime.startsWith("image/")) {
        await mkdir(join(directory, "variants"));
        const target = join(directory, "variants", "display.webp");
        await sharp(path, { limitInputPixels: 40000000 })
          .rotate()
          .resize({
            width: 1920,
            height: 1920,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 85 })
          .toFile(target);
        if ((await stat(target)).size < size)
          previewKey = join(key, "variants", "display.webp");
        else await rm(target);
        const thumb = join(directory, "variants", "thumbnail.webp");
        await sharp(path, { limitInputPixels: 40000000 })
          .rotate()
          .resize({
            width: 320,
            height: 180,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 70 })
          .toFile(thumb);
        if ((await stat(thumb)).size < size)
          thumbnailKey = join(key, "variants", "thumbnail.webp");
        else await rm(thumb);
      }
      return await this.database.db.transaction(async (tx) => {
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, pid))
          .for("update");
        await resolveProjectPermissions(tx, u, pid);
        const used = await tx.execute(
          sql`SELECT COALESCE(SUM(storage_bytes),0) AS total FROM study_assets WHERE project_id=${pid}`,
        );
        const storageBytes =
          size +
          (previewKey ? (await stat(join(this.root(), previewKey))).size : 0) +
          (thumbnailKey
            ? (await stat(join(this.root(), thumbnailKey))).size
            : 0);
        if (Number(used.rows[0]?.total) + storageBytes > 10 * 1024 ** 3)
          fail(409, "STORAGE_FULL", "공간 저장 용량을 초과했습니다.");
        const [asset] = await tx
          .insert(assets)
          .values({
            id,
            projectId: pid,
            ownerId: u.id,
            originalName: name,
            mime,
            size,
            storageBytes,
            storageKey,
            previewKey,
            thumbnailKey,
          })
          .returning();
        return { id: asset.id, name, size, mime };
      });
    } catch (e) {
      await rm(directory, { recursive: true, force: true });
      throw e;
    }
  }
  async read(
    u: User,
    pid: string,
    id: string,
    preview: boolean | "thumbnail",
    range?: string,
  ) {
    const access = await this.access(u, pid);
    const db = this.database.db;
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, uuid(id)), eq(assets.projectId, pid)));
    if (!asset) fail(404, "NOT_FOUND", "파일을 찾을 수 없습니다.");
    let liveShared = false;
    const visible = await db
      .select({ shared: liveRooms.shared })
      .from(liveRooms)
      .innerJoin(sessions, eq(sessions.id, liveRooms.sessionId))
      .innerJoin(programs, eq(programs.id, sessions.programId))
      .innerJoin(liveConnections, eq(liveConnections.sessionId, sessions.id))
      .where(
        and(
          eq(programs.projectId, pid),
          isNull(liveRooms.endedAt),
          eq(liveConnections.userId, u.id),
          isNull(liveConnections.leftAt),
          gt(liveConnections.lastSeenAt, new Date(Date.now() - 15000)),
        ),
      );
    liveShared = visible.some((r) => {
      const shared = JSON.parse(r.shared);
      return (
        shared.asset?.id === id ||
        shared.elements?.some((e: { assetId?: string }) => e.assetId === id)
      );
    });
    const deckRefs = await db
      .select({
        programId: decks.programId,
        sourceSubmissionId: decks.sourceSubmissionId,
      })
      .from(deckAssets)
      .innerJoin(decks, eq(decks.id, deckAssets.deckId))
      .where(eq(deckAssets.assetId, id));
    let deckAccess = false;
    for (const ref of deckRefs) {
      const [p] = await db
        .select()
        .from(programs)
        .where(
          and(eq(programs.id, ref.programId), eq(programs.projectId, pid)),
        );
      if (!p) continue;
      const [target] = await db
        .select()
        .from(programMembers)
        .where(
          and(
            eq(programMembers.programId, p.id),
            eq(programMembers.userId, u.id),
            isNull(programMembers.leftAt),
          ),
        );
      const [host] = await db
        .select()
        .from(hosts)
        .where(and(eq(hosts.programId, p.id), eq(hosts.userId, u.id)));
      if (ref.sourceSubmissionId) {
        const [source] = await db
          .select()
          .from(versions)
          .where(eq(versions.id, ref.sourceSubmissionId));
        if (
          !source ||
          (source.userId !== u.id &&
            !host &&
            !access.permissions.includes("study.submissions.read"))
        )
          continue;
      }
      if (
        target ||
        host ||
        access.permissions.includes("study.materials.manage") ||
        (p.status === "preparing" && p.membershipMode === "all")
      )
        deckAccess = true;
    }
    if (asset.ownerId !== u.id && !liveShared && !deckAccess) {
      const refs = await db
        .select({ programId: activities.programId })
        .from(links)
        .innerJoin(versions, eq(versions.id, links.submissionId))
        .innerJoin(activities, eq(activities.id, versions.activityId))
        .where(eq(links.assetId, id));
      const assignments = await db
        .select()
        .from(hosts)
        .where(eq(hosts.userId, u.id));
      if (
        !refs.length ||
        (!access.permissions.includes("study.submissions.read") &&
          !refs.some((r) =>
            assignments.some((h) => h.programId === r.programId),
          ))
      )
        fail(403, "FORBIDDEN", "파일 조회 권한이 없습니다.");
    }
    const derivedKey =
      preview === "thumbnail"
        ? (asset.thumbnailKey ?? asset.previewKey)
        : preview
          ? asset.previewKey
          : null;
    const isPreview = !!derivedKey;
    const path = join(this.root(), derivedKey ?? asset.storageKey);
    const size = (await stat(path)).size;
    let start = 0,
      end = size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        fail(416, "RANGE_INVALID", "요청한 파일 구간을 읽을 수 없습니다.");
      if (!match![1]) {
        const suffix = Number(match![2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0)
          fail(416, "RANGE_INVALID", "파일 구간을 확인해주세요.");
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match![1]);
        end = match![2] ? Math.min(Number(match![2]), size - 1) : size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= size ||
        end < start
      )
        fail(416, "RANGE_INVALID", "파일 구간을 확인해주세요.");
    }
    return {
      stream: createReadStream(path, { start, end }),
      name: asset.originalName,
      mime: isPreview ? "image/webp" : asset.mime,
      size,
      length: end - start + 1,
      contentRange: range ? `bytes ${start}-${end}/${size}` : null,
    };
  }
}
