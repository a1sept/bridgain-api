import { dueDate } from "./due-date.js";
import { parseRichDocument, richDocumentText } from "./rich-document.js";
import { fail } from "../auth/security.js";
import type { StagePlan } from "../db/schema/project-work.js";
import { bounded, uuid } from "./workspace.service.js";

export function parseStagePlans(
  raw: unknown,
  draft = false,
): StagePlan[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || (!draft && !raw.length) || raw.length > 30)
    fail(400, "STAGE_REQUIRED", "단계를 1개 이상 30개 이하로 구성해주세요.");
  const list = (v: unknown) => {
    if (!Array.isArray(v) || (!draft && !v.length) || v.length > 100)
      fail(
        400,
        "STAGE_MEMBER_REQUIRED",
        "단계별 담당자와 승인자를 지정해주세요.",
      );
    return [...new Set((v as unknown[]).map((x) => uuid(x).toLowerCase()))];
  };
  const stages: StagePlan[] = (raw as unknown[]).map((value): StagePlan => {
    if (!value || typeof value !== "object")
      fail(400, "INVALID_STAGE", "단계 정보를 확인해주세요.");
    const s = value as Record<string, unknown>;
    const id = bounded(s.id, 100);
    const mode = bounded(s.completionMode, 20);
    if (!["document", "design", "code", "test", "deploy"].includes(mode))
      fail(400, "INVALID_STAGE_MODE", "단계 완료 방식을 확인해주세요.");
    if (!Array.isArray(s.dependsOn) || s.dependsOn.length > 30)
      fail(400, "INVALID_DEPENDENCY", "선행 단계를 확인해주세요.");
    const document = parseRichDocument(s.briefDocument);
    return {
      id,
      name: bounded(s.name ?? "", 100, !draft),
      title: bounded(s.title ?? "", 200, !draft),
      brief: bounded(
        document ? richDocumentText(document) : (s.brief ?? ""),
        10000,
        !draft,
      ),
      ...(s.briefDocument !== undefined ? { briefDocument: document } : {}),
      ...(s.dueDate !== undefined ? { dueDate: dueDate(s.dueDate) } : {}),
      completionMode: mode as StagePlan["completionMode"],
      assigneeIds: list(s.assigneeIds),
      reviewerIds: list(s.reviewerIds),
      dependsOn: [
        ...new Set((s.dependsOn as unknown[]).map((x) => bounded(x, 100))),
      ],
    };
  });
  const map = new Map(stages.map((s) => [s.id, s]));
  if (map.size !== stages.length)
    fail(400, "DUPLICATE_STAGE", "단계 ID가 중복되었습니다.");
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id))
      fail(400, "STAGE_CYCLE", "단계가 순환하지 않도록 구성해주세요.");
    if (done.has(id)) return;
    const stage = map.get(id);
    if (!stage)
      fail(400, "INVALID_DEPENDENCY", "존재하는 선행 단계를 선택해주세요.");
    visiting.add(id);
    stage!.dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  stages.forEach((s) => visit(s.id));
  return stages;
}
