import { StudyEventsService } from "./study-events.service.js";
import { studySlide } from "./study-slide.js";
import { Injectable } from "@nestjs/common";
import { and, eq, desc, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { DatabaseService } from "../db/database.service.js";
import {
  studyDecks as decks,
  studySessions as sessions,
  studyDeckAssets as deckAssets,
  studySubmissionVersions as submissions,
  studySubmissionAssets as submissionAssets,
  studyActivities as activities,
  studyAssets as assets,
  studyDeckEditors as editors,
  studyDeckVersions as versions,
  studyPrograms as programs,
  studyOrganizers as organizers,
  studyProgramMembers as targets,
} from "../db/schema/study.js";
import { projectMemberships as pm, projects } from "../db/schema/workspace.js";
import { resolveProjectPermissions } from "./project-roles.service.js";
import { uuid, bounded } from "./workspace.service.js";
import { fail } from "../auth/security.js";
type User = { id: string; accountType: string; displayName?: string };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
@Injectable()
export class StudyDecksService {
  private readonly presence = new Map<
    string,
    Map<
      string,
      {
        userId: string;
        name: string;
        pageId: string;
        field: string;
        start: number;
        end: number;
        at: number;
      }
    >
  >();
  constructor(
    private readonly database: DatabaseService,
    private readonly events: StudyEventsService = new StudyEventsService(),
  ) {}
  private async access(tx: Tx, u: User, pid: string, programId: string) {
    await tx
      .select()
      .from(projects)
      .where(eq(projects.id, uuid(pid)))
      .for("update");
    const access = await resolveProjectPermissions(tx, u, uuid(pid));
    if (access.kind !== "study")
      fail(404, "NOT_FOUND", "스터디를 찾을 수 없습니다.");
    const [p] = await tx
      .select()
      .from(programs)
      .where(and(eq(programs.id, uuid(programId)), eq(programs.projectId, pid)))
      .for("update");
    if (!p) fail(404, "NOT_FOUND", "프로그램을 찾을 수 없습니다.");
    const [host] = await tx
      .select()
      .from(organizers)
      .where(and(eq(organizers.programId, p.id), eq(organizers.userId, u.id)));
    const manage =
      !!host || access.permissions.includes("study.materials.manage");
    const [target] = await tx
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.programId, p.id),
          eq(targets.userId, u.id),
          isNull(targets.leftAt),
        ),
      );
    if (
      !manage &&
      !access.permissions.includes("study.live.host") &&
      !target &&
      !(p.status === "preparing" && p.membershipMode === "all")
    )
      fail(403, "FORBIDDEN", "프로그램 참여 대상이 아닙니다.");
    return { program: p, manage };
  }
  private async source(
    tx: Tx,
    u: User,
    pid: string,
    programId: string,
    id: string,
  ) {
    const a = await resolveProjectPermissions(tx, u, pid);
    const [v] = await tx
      .select({
        id: submissions.id,
        userId: submissions.userId,
        body: submissions.body,
        title: activities.title,
        programId: activities.programId,
        sessionId: activities.sessionId,
      })
      .from(submissions)
      .innerJoin(activities, eq(activities.id, submissions.activityId))
      .where(
        and(eq(submissions.id, uuid(id)), eq(activities.programId, programId)),
      );
    const [host] = await tx
      .select()
      .from(organizers)
      .where(
        and(eq(organizers.programId, programId), eq(organizers.userId, u.id)),
      );
    return v &&
      (v.userId === u.id ||
        host ||
        a.permissions.includes("study.submissions.read"))
      ? v
      : null;
  }
  async create(
    u: User,
    pid: string,
    programId: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, programId);
      const source = b.sourceSubmissionId
        ? await this.source(tx, u, pid, programId, uuid(b.sourceSubmissionId))
        : null;
      if (b.sourceSubmissionId && !source)
        fail(403, "FORBIDDEN", "원본 제출물을 조회할 수 없습니다.");
      if ((!a.manage && !source) || a.program.archivedAt)
        fail(403, "FORBIDDEN", "발표 자료를 만들 수 없습니다.");
      const sessionId = b.sessionId ? uuid(b.sessionId) : source?.sessionId ?? null;
      if (sessionId) {
        const [session] = await tx.select().from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.programId, programId)));
        if (!session) fail(404, "NOT_FOUND", "이 프로그램의 회차를 찾을 수 없습니다.");
      }
      const doc = new Y.Doc();
      const pages = doc.getArray<string>("pages");
      const page = crypto.randomUUID();
      pages.push([page]);
      doc
        .getText(`title:${page}`)
        .insert(0, source ? source.title.slice(0, 120) : "새 발표");
      doc
        .getText(`body:${page}`)
        .insert(0, source ? source.body : "함께 이야기할 내용을 적어보세요.");
      const files = source
        ? await tx
            .select({ id: assets.id, mime: assets.mime })
            .from(submissionAssets)
            .innerJoin(assets, eq(assets.id, submissionAssets.assetId))
            .where(eq(submissionAssets.submissionId, source.id))
        : [];
      for (const file of files) {
        const mediaPage = crypto.randomUUID(),
          elementId = crypto.randomUUID();
        pages.push([mediaPage]);
        doc.getText(`title:${mediaPage}`).insert(0, "제출 첨부 · 발표용 메모");
        doc.getArray<string>(`elements:${mediaPage}`).push([elementId]);
        const m = doc.getMap(`element:${elementId}`);
        for (const [k, v] of Object.entries({
          type: "asset",
          assetId: file.id,
          mime: file.mime,
          x: 6,
          y: 22,
          w: 88,
          h: 72,
          fontSize: 24,
          color: "#202431",
        }))
          m.set(k, v);
      }

      const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
      doc.destroy();
      const created = (
        await tx
          .insert(decks)
          .values({
            programId,
            sessionId,
            title: bounded(
              b.title ??
                (source
                  ? `발표용 사본 · ${source.title}`.slice(0, 120)
                  : "발표 자료"),
              120,
            ),
            sourceSubmissionId: source?.id ?? null,
            state,
          })
          .returning()
      )[0];
      if (source && !a.manage)
        await tx.insert(editors).values({ deckId: created.id, userId: u.id });
      if (files.length)
        await tx
          .insert(deckAssets)
          .values(files.map((f) => ({ deckId: created.id, assetId: f.id })));
      return created;
    });
  }
  async list(u: User, pid: string, programId: string) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, programId),
        all = await tx
          .select({
            id: decks.id,
            sessionId: decks.sessionId,
            title: decks.title,
            updatedAt: decks.updatedAt,
            sourceSubmissionId: decks.sourceSubmissionId,
          })
          .from(decks)
          .where(eq(decks.programId, programId));
      const visible = [];
      for (const d of all)
        if (
          !d.sourceSubmissionId ||
          (await this.source(tx, u, pid, programId, d.sourceSubmissionId))
        )
          visible.push(d);
      return { decks: visible, canManage: a.manage && !a.program.archivedAt };
    });
  }
  async get(u: User, pid: string, programId: string, id: string) {
    return this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, programId);
      const [d] = await tx
        .select()
        .from(decks)
        .where(and(eq(decks.id, uuid(id)), eq(decks.programId, programId)));
      if (!d) fail(404, "NOT_FOUND", "발표 자료를 찾을 수 없습니다.");
      if (
        d.sourceSubmissionId &&
        !(await this.source(tx, u, pid, programId, d.sourceSubmissionId))
      )
        fail(403, "FORBIDDEN", "원본 조회 권한이 필요합니다.");
      const es = await tx.select().from(editors).where(eq(editors.deckId, id));
      const canEdit =
        !a.program.archivedAt &&
        (a.manage || es.some((e) => e.userId === u.id));
      const room = this.presence.get(id);
      if (room) {
        for (const [key, v] of room)
          if (Date.now() - v.at > 15000) room.delete(key);
        if (!room.size) this.presence.delete(id);
      }
      return {
        ...d,
        currentUserId: u.id,
        canEdit,
        canManage: a.manage && !a.program.archivedAt,
        editorIds: es.map((e) => e.userId),
        presence: [...(room?.values() ?? [])].filter((p) => p.userId !== u.id),
      };
    });
  }
  async update(
    u: User,
    pid: string,
    programId: string,
    id: string,
    b: Record<string, unknown>,
  ) {
    const result = await this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, programId);
      const [d] = await tx
        .select()
        .from(decks)
        .where(and(eq(decks.id, uuid(id)), eq(decks.programId, programId)))
        .for("update");
      if (!d) fail(404, "NOT_FOUND", "발표 자료를 찾을 수 없습니다.");
      if (
        d.sourceSubmissionId &&
        !(await this.source(tx, u, pid, programId, d.sourceSubmissionId))
      )
        fail(403, "FORBIDDEN", "원본 조회 권한이 필요합니다.");
      const [editor] = await tx
        .select()
        .from(editors)
        .where(and(eq(editors.deckId, id), eq(editors.userId, u.id)));
      if (a.program.archivedAt || (!a.manage && !editor))
        fail(403, "FORBIDDEN", "편집 권한이 없습니다.");
      if (b.epoch !== d.epoch)
        fail(
          409,
          "DECK_RESTORED",
          "이전 버전으로 복원되었습니다. 새로 열어주세요.",
        );
      const update = bounded(b.update, 700000);
      let state: string;
      const assetIds = new Set<string>();
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, Buffer.from(d.state, "base64"));
        Y.applyUpdate(doc, Buffer.from(update, "base64"));
        const pageIds = doc.getArray<string>("pages").toArray();
        for (const pageId of pageIds) {
          uuid(pageId);
          for (const e of studySlide(doc, pageId).elements)
            if (e.assetId) assetIds.add(e.assetId);
          if (
            doc.getText(`title:${pageId}`).length > 120 ||
            doc.getText(`body:${pageId}`).length > 10000
          )
            fail(400, "DECK_LIMIT", "페이지 내용이 너무 깁니다.");
        }
        state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
        if (state.length > 700000 || doc.getArray("pages").length > 100)
          fail(400, "DECK_LIMIT", "발표 자료 크기 제한을 초과했습니다.");
      } catch {
        fail(400, "INVALID_DOCUMENT", "발표 자료 변경 내용을 확인해주세요.");
      } finally {
        doc.destroy();
      }
      for (const assetId of assetIds) {
        const [file] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, assetId), eq(assets.projectId, pid)));
        const [reference] = await tx
          .select()
          .from(deckAssets)
          .where(
            and(eq(deckAssets.deckId, id), eq(deckAssets.assetId, assetId)),
          );
        if (!file || (!reference && file.ownerId !== u.id))
          fail(
            403,
            "FORBIDDEN",
            "직접 올린 파일 또는 이 발표 자료의 파일만 배치할 수 있습니다.",
          );
        await tx
          .insert(deckAssets)
          .values({ deckId: id, assetId })
          .onConflictDoNothing();
      }
      if (state! === d.state) return d;
      await tx
        .insert(versions)
        .values({ deckId: id, state: d.state, actorId: u.id });
      return (
        await tx
          .update(decks)
          .set({ state: state!, updatedAt: new Date() })
          .where(eq(decks.id, id))
          .returning()
      )[0];
    });
    this.events.publish(pid);
    return result;
  }
  async history(
    u: User,
    pid: string,
    programId: string,
    id: string,
    cursor?: string,
  ) {
    await this.get(u, pid, programId, id);
    // Keyset pagination also works when several updates have the same timestamp.
    let boundary: { id: string; createdAt: Date } | undefined;
    if (cursor) {
      [boundary] = await this.database.db
        .select({ id: versions.id, createdAt: versions.createdAt })
        .from(versions)
        .where(and(eq(versions.deckId, id), eq(versions.id, uuid(cursor))));
      if (!boundary)
        fail(400, "INVALID_CURSOR", "버전 목록을 다시 열어주세요.");
    }
    const rows = await this.database.db
      .select({
        id: versions.id,
        actorId: versions.actorId,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(
        and(
          eq(versions.deckId, id),
          boundary
            ? sql`(${versions.createdAt}, ${versions.id}) < ((SELECT created_at FROM study_deck_versions WHERE id=${boundary.id}::uuid), ${boundary.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(versions.createdAt), desc(versions.id))
      .limit(51);
    return {
      versions: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49].id : null,
    };
  }
  async configure(
    u: User,
    pid: string,
    programId: string,
    id: string,
    b: Record<string, unknown>,
  ) {
    const result = await this.database.db.transaction(async (tx) => {
      const a = await this.access(tx, u, pid, programId);
      if (!a.manage || a.program.archivedAt)
        fail(403, "FORBIDDEN", "자료 운영 권한이 필요합니다.");
      const [d] = await tx
        .select()
        .from(decks)
        .where(and(eq(decks.id, uuid(id)), eq(decks.programId, programId)))
        .for("update");
      if (!d) fail(404, "NOT_FOUND", "자료를 찾을 수 없습니다.");
      if (
        d.sourceSubmissionId &&
        !(await this.source(tx, u, pid, programId, d.sourceSubmissionId))
      )
        fail(403, "FORBIDDEN", "원본 조회 권한이 필요합니다.");
      if (b.restoreVersionId) {
        const [v] = await tx
          .select()
          .from(versions)
          .where(
            and(
              eq(versions.id, uuid(b.restoreVersionId)),
              eq(versions.deckId, id),
            ),
          );
        if (!v) fail(404, "NOT_FOUND", "버전을 찾을 수 없습니다.");
        await tx
          .insert(versions)
          .values({ deckId: id, state: d.state, actorId: u.id });
        return (
          await tx
            .update(decks)
            .set({ state: v.state, epoch: d.epoch + 1, updatedAt: new Date() })
            .where(eq(decks.id, id))
            .returning()
        )[0];
      }
      if (!Array.isArray(b.editorIds) || b.editorIds.length > 100)
        fail(400, "VALIDATION_ERROR", "공동 편집자를 확인해주세요.");
      const ids = [...new Set((b.editorIds as unknown[]).map(uuid))];
      const members = await tx.select().from(pm).where(eq(pm.projectId, pid));
      const ts = await tx
        .select()
        .from(targets)
        .where(eq(targets.programId, programId));
      const hs = await tx
        .select()
        .from(organizers)
        .where(eq(organizers.programId, programId));
      if (
        ids.some(
          (id) =>
            !members.some((m) => m.userId === id) ||
            (!(
              a.program.status === "preparing" &&
              a.program.membershipMode === "all"
            ) &&
              !ts.some((t) => t.userId === id && !t.leftAt) &&
              !hs.some((h) => h.userId === id)),
        )
      )
        fail(400, "VALIDATION_ERROR", "프로그램 참여자만 추가할 수 있습니다.");
      if (d.sourceSubmissionId)
        for (const userId of ids)
          if (
            !(await this.source(
              tx,
              { id: userId, accountType: "team" },
              pid,
              programId,
              d.sourceSubmissionId,
            ))
          )
            fail(
              403,
              "FORBIDDEN",
              "사본의 공동 편집자는 원본 조회 권한이 있어야 합니다.",
            );
      await tx.delete(editors).where(eq(editors.deckId, id));
      if (ids.length)
        await tx
          .insert(editors)
          .values(ids.map((userId) => ({ deckId: id, userId })));
      return { ok: true };
    });
    this.events.publish(pid);
    return result;
  }
  async heartbeat(
    u: User,
    pid: string,
    programId: string,
    id: string,
    b: Record<string, unknown>,
  ) {
    const d = await this.get(u, pid, programId, id);
    if (!d.canEdit) fail(403, "FORBIDDEN", "편집 권한이 없습니다.");
    const pageId = bounded(b.pageId ?? "", 100, false);
    let room = this.presence.get(id);
    if (!room) {
      room = new Map();
      this.presence.set(id, room);
    }
    room.set(u.id, {
      userId: u.id,
      name: u.displayName ?? "회원",
      pageId,
      field: bounded(b.field ?? "", 120, false),
      start: Number.isInteger(b.start)
        ? Math.max(0, Math.min(10000, Number(b.start)))
        : 0,
      end: Number.isInteger(b.end)
        ? Math.max(0, Math.min(10000, Number(b.end)))
        : 0,
      at: Date.now(),
    });
    if (this.presence.size > 500) {
      for (const [key, r] of this.presence) {
        if ([...r.values()].every((v) => Date.now() - v.at > 15000))
          this.presence.delete(key);
      }
    }
    return { ok: true };
  }
}
