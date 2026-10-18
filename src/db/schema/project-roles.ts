import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  unique,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { projects, projectMemberships } from "./workspace.js";
export const projectRoles = pgTable(
  "project_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#2D63ED"),
    permissions: text("permissions").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("project_role_color_check", sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
    unique("project_role_name_unique").on(t.projectId, t.name),
    unique("project_role_project_id_unique").on(t.projectId, t.id),
  ],
);
export const projectMemberRoles = pgTable(
  "project_member_roles",
  {
    projectId: uuid("project_id").notNull(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId, t.roleId] }),
    foreignKey({
      columns: [t.projectId, t.userId],
      foreignColumns: [projectMemberships.projectId, projectMemberships.userId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.projectId, t.roleId],
      foreignColumns: [projectRoles.projectId, projectRoles.id],
    }).onDelete("cascade"),
  ],
);
