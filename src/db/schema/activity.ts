import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects } from "./workspace.js";
export type ActivityRequest = { id: string; title: string; origin: string };
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    kind: text("kind").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    meetingId: uuid("meeting_id"),
    taskId: uuid("task_id"),
    requestIds: uuid("request_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    requests: jsonb("requests")
      .$type<ActivityRequest[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    assigneeIds: uuid("assignee_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    sourceKey: text("source_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("activity_source_key_idx").on(t.sourceKey),
    index("activity_feed_idx").on(t.occurredAt, t.id),
    index("activity_project_feed_idx").on(t.projectId, t.occurredAt, t.id),
    index("activity_requests_idx").using("gin", t.requestIds),
  ],
);
