/** Starter roles are created once, atomically with each new project. */
export function defaultProjectRoles(allPermissions: readonly string[]) {
  return [
    {
      name: "프로젝트 관리자",
      color: "#2D63ED",
      permissions: [...allPermissions],
    },
    {
      name: "기획자",
      color: "#7C3AED",
      permissions: [
        "requests.read",
        "requests.create",
        "meetings.read",
        "meetings.create",
        "meetings.update",
        "documents.read",
        "documents.create",
        "documents.update",
        "tasks.read",
        "tasks.assign",
        "activity.read",
      ],
    },
    {
      name: "디자이너",
      color: "#DB2777",
      permissions: [
        "requests.read",
        "meetings.read",
        "documents.read",
        "documents.create",
        "documents.update",
        "tasks.read",
        "tasks.progress",
        "activity.read",
      ],
    },
    {
      name: "개발자",
      color: "#059669",
      permissions: [
        "requests.read",
        "requests.create",
        "meetings.read",
        "meetings.create",
        "documents.read",
        "documents.create",
        "documents.update",
        "tasks.read",
        "tasks.progress",
        "activity.read",
      ],
    },
    {
      name: "QA",
      color: "#D97706",
      permissions: [
        "requests.read",
        "requests.create",
        "meetings.read",
        "documents.read",
        "tasks.read",
        "tasks.progress",
        "activity.read",
      ],
    },
  ];
}
