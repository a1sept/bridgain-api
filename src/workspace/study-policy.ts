/** Study permissions never enter the development permission catalogue. */
export const studyPermissions = [
  "study.programs.manage",
  "study.sessions.manage",
  "study.activities.manage",
  "study.materials.manage",
  "study.submissions.read",
  "study.attendance.read",
  "study.live.host",
  "study.members.invite",
  "study.members.remove",
  "study.roles.manage",
  "study.roles.assign",
  "study.settings.manage",
  "study.attendance.adjust",
] as const;
export const studyDeputyPermissions = studyPermissions.filter(
  (p) =>
    ![
      "study.members.remove",
      "study.roles.manage",
      "study.roles.assign",
      "study.settings.manage",
      "study.attendance.adjust",
    ].includes(p),
);
export function studyRoleTemplates() {
  return [
    { name: "관리자", color: "#2D63ED", permissions: [...studyPermissions] },
    {
      name: "부관리자",
      color: "#7856B8",
      permissions: [...studyDeputyPermissions],
    },
    { name: "회원", color: "#64748B", permissions: [] as string[] },
  ];
}
export function studyEffectivePermissions(
  owner: boolean,
  values: string[],
): string[] {
  return studyPermissions.filter((p) => owner || values.includes(p));
}
