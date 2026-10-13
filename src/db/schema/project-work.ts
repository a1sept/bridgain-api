import { sql } from "drizzle-orm";
import {
  pgTable,
  boolean,
  uniqueIndex,
  uuid,
  text,
  timestamp,
  date,
  integer,
  primaryKey,
  index,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./workspace.js";
import { projectRequests } from "./requests.js";
const common = () => ({
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const projectTasks = pgTable(
  "project_tasks",
  {
    ...common(),
    version: uuid("version").notNull().defaultRandom(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("normal"),
    dueDate: date("due_date"),
    repositoryUrl: text("repository_url"),
    workBranch: text("work_branch").notNull().default(""),
    liveBranch: text("live_branch").notNull().default("main"),
    pullRequestUrl: text("pull_request_url"),
    mergeCommit: text("merge_commit").notNull().default(""),
    deploymentUrl: text("deployment_url"),
    resultSummary: text("result_summary").notNull().default(""),
    dbChanges: text("db_changes").notNull().default(""),
    apiChanges: text("api_changes").notNull().default(""),
    frontendChanges: text("frontend_changes").notNull().default(""),
    verification: text("verification").notNull().default(""),
    mergeApprovalRequired: boolean("merge_approval_required")
      .notNull()
      .default(false),
    mergeReviewerId: uuid("merge_reviewer_id").references(() => users.id),
    reviewStatus: text("review_status").notNull().default("none"),
    reviewHeadSha: text("review_head_sha").notNull().default(""),
    reviewBaseSha: text("review_base_sha").notNull().default(""),
    reviewRequestedBy: uuid("review_requested_by").references(() => users.id),
    reviewRequestId: uuid("review_request_id"),
  },
  (t) => [
    check(
      "task_review_status_check",
      sql`${t.reviewStatus} IN ('none','pending','approved','changes_requested','stale')`,
    ),
    uniqueIndex("task_approval_pr_unique")
      .on(t.pullRequestUrl)
      .where(
        sql`${t.mergeApprovalRequired} = true AND ${t.pullRequestUrl} IS NOT NULL`,
      ),
    index("task_project_idx").on(t.projectId, t.createdAt),
    check(
      "task_status_check",
      sql`${t.status} IN ('todo','in_progress','done','released')`,
    ),
    check(
      "task_priority_check",
      sql`${t.priority} IN ('urgent','high','normal','low')`,
    ),
  ],
);
export const taskAssignees = pgTable(
  "task_assignees",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => projectTasks.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.userId] })],
);
export const taskRequests = pgTable(
  "task_requests",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => projectTasks.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.requestId] }),
    index("task_request_idx").on(t.requestId),
  ],
);
export const projectMeetings = pgTable(
  "project_meetings",
  {
    ...common(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    location: text("location").notNull().default(""),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("scheduled"),
    requestId: uuid("request_id").references(() => projectRequests.id),
    decisionStatus: text("decision_status").notNull().default("draft"),
  },
  (t) => [
    check(
      "meeting_decision_check",
      sql`${t.decisionStatus} IN ('draft','final')`,
    ),
    index("meeting_project_idx").on(t.projectId, t.scheduledAt),
    check(
      "meeting_duration_check",
      sql`${t.durationMinutes} BETWEEN 15 AND 480`,
    ),
    check(
      "meeting_status_check",
      sql`${t.status} IN ('scheduled','completed')`,
    ),
  ],
);
export const projectDocuments = pgTable(
  "project_documents",
  {
    ...common(),
    category: text("category").notNull(),
    content: text("content").notNull().default(""),
    url: text("url"),
  },
  (t) => [
    index("document_project_idx").on(t.projectId, t.updatedAt),
    check(
      "document_category_check",
      sql`${t.category} IN ('plan','design','api','meeting','erd','frontend','other')`,
    ),
  ],
);
export const projectActivity = pgTable(
  "project_activity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    entityId: uuid("entity_id").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("activity_project_idx").on(t.projectId, t.createdAt)],
);

export const meetingRequests = pgTable(
  "meeting_requests",
  {
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => projectMeetings.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
    planning: text("planning").notNull().default(""),
    uiNotes: text("ui_notes").notNull().default(""),
    apiNotes: text("api_notes").notNull().default(""),
    dbNotes: text("db_notes").notNull().default(""),
    priority: text("priority").notNull().default("normal"),
    assigneeIds: jsonb("assignee_ids").$type<string[]>().notNull().default([]),
    taskId: uuid("task_id").references(() => projectTasks.id),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.requestId] }),
    check(
      "meeting_request_priority_check",
      sql`${t.priority} IN ('urgent','high','normal','low')`,
    ),
  ],
);
export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => projectDocuments.id),
    title: text("title").notNull(),
    category: text("category").notNull(),
    content: text("content").notNull(),
    url: text("url"),
    changeSummary: text("change_summary").notNull(),
    taskId: uuid("task_id").references(() => projectTasks.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("document_version_idx").on(t.documentId, t.createdAt)],
);

export const taskReviewEvents = pgTable(
  "task_review_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => projectTasks.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    headSha: text("head_sha").notNull().default(""),
    baseSha: text("base_sha").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("task_review_history_idx").on(t.taskId, t.createdAt)],
);

export const taskResultEntries = pgTable(
  "task_result_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => projectTasks.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    changeSummary: text("change_summary").notNull(),
    resultSummary: text("result_summary").notNull().default(""),
    dbChanges: text("db_changes").notNull().default(""),
    apiChanges: text("api_changes").notNull().default(""),
    frontendChanges: text("frontend_changes").notNull().default(""),
    verification: text("verification").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("task_result_entries_idx").on(t.taskId, t.createdAt)],
);
