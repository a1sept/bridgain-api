import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../db/database.service.js";
import {
  projectStageSettings,
  type ProjectStageType,
  type ProjectStagePreset,
} from "../db/schema/project-work.js";
import {
  RequestsService,
  requireProjectPermission,
} from "./requests.service.js";
import { bounded, uuid } from "./workspace.service.js";
import { projectRoles } from "../db/schema/project-roles.js";
import { fail } from "../auth/security.js";
import { parseStagePlans } from "./stage-plan-policy.js";
const modes = ["document", "design", "code", "test", "deploy"];
export function defaultStageSettings() {
  const stageTypes: ProjectStageType[] = [
    { id: "plan", name: "기획", completionMode: "document" },
    { id: "design", name: "디자인", completionMode: "design" },
    { id: "code", name: "개발", completionMode: "code" },
    { id: "qa", name: "QA", completionMode: "test" },
    { id: "deploy", name: "배포", completionMode: "deploy" },
  ];
  const s = (
    id: string,
    name: string,
    completionMode: ProjectStageType["completionMode"],
    dependsOn: string[] = [],
  ) => ({ id, name, completionMode, dependsOn });
  const presets: ProjectStagePreset[] = [
    {
      id: "bug",
      name: "버그 수정",
      stages: [
        s("code", "개발", "code"),
        s("deploy", "배포", "deploy", ["code"]),
      ],
    },
    {
      id: "feature",
      name: "새 기능",
      stages: [
        s("plan", "기획", "document"),
        s("design", "디자인", "design", ["plan"]),
        s("frontend", "프론트엔드", "code", ["design"]),
        s("backend", "백엔드", "code", ["design"]),
        s("qa", "QA", "test", ["frontend", "backend"]),
        s("deploy", "배포", "deploy", ["qa"]),
      ],
    },
  ];
  return { stageTypes, presets };
}
export function parseStageSettings(body: Record<string, unknown>) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(400, "INVALID_STAGE_SETTINGS", "단계 설정을 확인해주세요.");
  if (
    !Array.isArray(body.stageTypes) ||
    !body.stageTypes.length ||
    body.stageTypes.length > 30 ||
    !Array.isArray(body.presets) ||
    body.presets.length > 30
  )
    fail(
      400,
      "INVALID_STAGE_SETTINGS",
      "단계 유형은 1~30개, 프리셋은 30개 이하로 구성해주세요.",
    );
  const stageTypes = (body.stageTypes as Record<string, unknown>[]).map((s) => {
    if (!s || typeof s !== "object")
      fail(400, "INVALID_STAGE_SETTINGS", "단계 유형을 확인해주세요.");
    const mode = bounded(s.completionMode, 20);
    if (!modes.includes(mode))
      fail(400, "INVALID_STAGE_MODE", "완료 방식을 확인해주세요.");
    if (
      s.roleIds !== undefined &&
      (!Array.isArray(s.roleIds) || s.roleIds.length > 100)
    )
      fail(400, "INVALID_STAGE_ROLES", "역할을 확인해주세요.");
    return {
      id: bounded(s.id, 100),
      name: bounded(s.name, 100),
      completionMode: mode as ProjectStageType["completionMode"],
      ...(s.roleIds
        ? {
            roleIds: [...new Set((s.roleIds as unknown[]).map((x) => uuid(x)))],
          }
        : {}),
    };
  });
  if (new Set(stageTypes.map((s) => s.id)).size !== stageTypes.length)
    fail(400, "DUPLICATE_STAGE", "단계 유형 ID가 중복되었습니다.");
  const member = "00000000-0000-4000-8000-000000000001";
  const presets = (body.presets as Record<string, unknown>[]).map((p) => {
    if (!p || typeof p !== "object" || !Array.isArray(p.stages))
      fail(400, "INVALID_PRESET", "프리셋을 확인해주세요.");
    const stages = parseStagePlans(
      (p.stages as Record<string, unknown>[]).map((s) => ({
        ...s,
        title: s?.name,
        brief: "프리셋",
        assigneeIds: [member],
        reviewerIds: [member],
      })),
    )!;
    return {
      id: bounded(p.id, 100),
      name: bounded(p.name, 100),
      stages: stages.map(({ id, name, completionMode, dependsOn }) => ({
        id,
        name,
        completionMode,
        dependsOn,
      })),
    };
  });
  if (new Set(presets.map((p) => p.id)).size !== presets.length)
    fail(400, "DUPLICATE_PRESET", "프리셋 ID가 중복되었습니다.");
  return { stageTypes, presets };
}
@Injectable()
export class StageSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly requests: RequestsService,
  ) {}
  async list(
    u: { id: string; displayName: string; accountType: string },
    pid: string,
  ) {
    return this.database.db.transaction(async (tx) => {
      const p = await this.requests.access(tx, u, pid);
      if (
        !p.isDeveloper ||
        !p.permissions.some((x) =>
          ["meetings.read", "tasks.assign", "project.settings"].includes(x),
        )
      )
        fail(403, "FORBIDDEN", "단계 설정 조회 권한이 없습니다.");
      const [row] = await tx
        .select()
        .from(projectStageSettings)
        .where(eq(projectStageSettings.projectId, pid));
      return {
        ...(row ?? defaultStageSettings()),
        canManage: p.permissions.includes("project.settings"),
      };
    });
  }
  async save(
    u: { id: string; displayName: string; accountType: string },
    pid: string,
    b: Record<string, unknown>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const p = await this.requests.access(tx, u, pid, true);
      requireProjectPermission(p, "project.settings");
      const settings = parseStageSettings(b);
      const roleIds = settings.stageTypes.flatMap((t) => t.roleIds ?? []);
      if (roleIds.length) {
        const roles = await tx
          .select({ id: projectRoles.id })
          .from(projectRoles)
          .where(eq(projectRoles.projectId, pid));
        if (roleIds.some((id) => !roles.some((r) => r.id === id)))
          fail(
            400,
            "INVALID_STAGE_ROLES",
            "이 프로젝트의 역할을 선택해주세요.",
          );
      }

      await tx
        .insert(projectStageSettings)
        .values({ projectId: pid, ...settings })
        .onConflictDoUpdate({
          target: projectStageSettings.projectId,
          set: settings,
        });
      return { ...settings, canManage: true };
    });
  }
}
