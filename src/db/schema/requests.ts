import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  customType,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./workspace.js";
const stamp = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
export const projectRequests = pgTable(
  "project_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    type: text("type").notNull(),
    priority: text("priority").notNull(),
    status: text("status").notNull().default("received"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: stamp(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("request_project_idx").on(t.projectId, t.createdAt),
    check("request_type_check", sql`${t.type} IN ('feature','bug','other')`),
    check(
      "request_priority_check",
      sql`${t.priority} IN ('urgent','high','normal','low')`,
    ),
    check(
      "request_status_check",
      sql`${t.status} IN ('received','in_progress','review','revision','completed','released')`,
    ),
  ],
);
export const requestAssignees = pgTable(
  "request_assignees",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] })],
);
export const requestEvents = pgTable(
  "request_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
    kind: text("kind").notNull(),
    status: text("status"),
    body: text("body"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    createdAt: stamp(),
  },
  (t) => [index("request_event_idx").on(t.requestId, t.createdAt)],
);
export const requestAttachments = pgTable(
  "request_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    content: bytes("content").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: stamp(),
  },
  (t) => [index("request_attachment_idx").on(t.requestId)],
);
