import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { projects } from "./workspace.js";
import { users } from "./auth.js";
export const channelMessages = pgTable(
  "channel_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    parentKey: text("parent_key"),
    targetKind: text("target_kind"),
    targetId: uuid("target_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("channel_project_time_idx").on(t.projectId, t.createdAt),
    index("channel_thread_idx").on(t.projectId, t.parentKey),
    check(
      "channel_target_check",
      sql`(${t.targetKind} IS NULL AND ${t.targetId} IS NULL) OR (${t.targetKind} IS NOT NULL AND ${t.targetKind} IN ('task','meeting') AND ${t.targetId} IS NOT NULL)`,
    ),
    check(
      "channel_body_check",
      sql`length(trim(${t.body})) BETWEEN 1 AND 5000`,
    ),
  ],
);
