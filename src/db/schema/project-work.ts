import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  primaryKey,
  index,
  check,
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
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("todo"),
    priority: text("priority").notNull().default("normal"),
    dueDate: date("due_date"),
  },
  (t) => [
    index("task_project_idx").on(t.projectId, t.createdAt),
    check(
      "task_status_check",
      sql`${t.status} IN ('todo','in_progress','done')`,
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
  },
  (t) => [
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
      sql`${t.category} IN ('plan','design','api','meeting','other')`,
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
