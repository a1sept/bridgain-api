/** Customer progress starts with the first task, including planning/design.
 * Non-code stages complete on work approval; code stages complete after deployment. */
export function customerWorkflowStage(
  tasks: {
    status: string;
    completionMode?: string;
    stageKey?: string | null;
  }[],
  linkedToReview = false,
) {
  if (!tasks.length) return linkedToReview ? "review" : "received";
  return tasks.every(
    (t) =>
      t.status === "released" ||
      (!!t.stageKey &&
        !["code", "deploy"].includes(t.completionMode ?? "code") &&
        t.status === "done"),
  )
    ? "completed"
    : "in_progress";
}
