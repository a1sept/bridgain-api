import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  check,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const teams = pgTable("teams", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: created(),
});
export const teamMemberships = pgTable(
  "team_memberships",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    permissionRole: text("permission_role").notNull().default("member"),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    check(
      "team_permission_check",
      sql`${t.permissionRole} IN ('owner','admin','member')`,
    ),
    uniqueIndex("team_single_owner")
      .on(t.teamId)
      .where(sql`${t.permissionRole} = 'owner'`),
    index("team_member_user_idx").on(t.userId),
  ],
);
export const teamMemberPositions = pgTable(
  "team_member_positions",
  {
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    position: text("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.position] }),
    foreignKey({
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMemberships.teamId, teamMemberships.userId],
    }),
    check(
      "team_position_check",
      sql`${t.position} IN ('planner','designer','developer')`,
    ),
  ],
);
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("preparing"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [
    check(
      "project_status_check",
      sql`${t.status} IN ('preparing','in_progress','completed')`,
    ),
    index("project_team_idx").on(t.teamId),
  ],
);
export const projectMemberships = pgTable(
  "project_memberships",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    accessRole: text("access_role").notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    check(
      "project_access_check",
      sql`${t.accessRole} IN ('manager','contributor','client')`,
    ),
    index("project_member_user_idx").on(t.userId),
  ],
);
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id),
    inviteeId: uuid("invitee_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("pending"),
    createdAt: created(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "invitation_status_check",
      sql`${t.status} IN ('pending','accepted','declined','canceled')`,
    ),
    check("invitation_not_self", sql`${t.inviterId} <> ${t.inviteeId}`),
    uniqueIndex("invitation_pending_unique")
      .on(t.projectId, t.inviteeId)
      .where(sql`${t.status} = 'pending'`),
    index("invitation_invitee_idx").on(t.inviteeId),
  ],
);
