import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  uniqueIndex,
  check,
  index,
} from "drizzle-orm/pg-core";
import { projects } from "./workspace.js";
import { users } from "./auth.js";
export const projectRepositoryManagers = pgTable(
  "project_repository_managers",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryUrl: text("repository_url").notNull(),
    managerUserId: uuid("manager_user_id").references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repositoryUrl] })],
);
export const repositoryAccessRequests = pgTable(
  "repository_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    repositoryUrl: text("repository_url").notNull(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id),
    managerUserId: uuid("manager_user_id").references(() => users.id),
    note: text("note").notNull().default(""),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("repository_access_pending_unique")
      .on(t.projectId, t.repositoryUrl, t.requesterId)
      .where(sql`${t.status}='pending'`),
    index("repository_access_project_time").on(t.projectId, t.createdAt),
    check(
      "repository_access_status",
      sql`${t.status} IN ('pending','resolved')`,
    ),
  ],
);
