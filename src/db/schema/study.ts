import { projectRoles } from "./project-roles.js";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  check,
  integer,
  boolean,
} from "drizzle-orm/pg-core";
import { projects } from "./workspace.js";
import { users } from "./auth.js";
export const studyPrograms = pgTable(
  "study_programs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    plannedSessionCount: integer("planned_session_count"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").notNull().default("preparing"),
    membershipMode: text("membership_mode").notNull().default("all"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "study_program_status",
      sql`${t.status} IN ('preparing','active','completed')`,
    ),
    check(
      "study_program_membership",
      sql`${t.membershipMode} IN ('all','selected')`,
    ),
  ],
);
export const studyProgramMembers = pgTable(
  "study_program_members",
  {
    leftAt: timestamp("left_at", { withTimezone: true }),
    programId: uuid("program_id")
      .notNull()
      .references(() => studyPrograms.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.programId, t.userId] })],
);
export const studyOrganizers = pgTable(
  "study_organizers",
  {
    programId: uuid("program_id")
      .notNull()
      .references(() => studyPrograms.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("host"),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.userId] }),
    check("study_organizer_role", sql`${t.role} IN ('host','deputy')`),
  ],
);
export const studySessions = pgTable(
  "study_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id")
      .notNull()
      .references(() => studyPrograms.id),
    seriesId: uuid("series_id"),
    seriesIndex: integer("series_index"),
    scheduleException: boolean("schedule_exception").notNull().default(false),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    location: text("location").notNull().default(""),
    status: text("status").notNull().default("scheduled"),
  },
  (t) => [
    check("study_session_times", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "study_session_status",
      sql`${t.status} IN ('scheduled','live','ended','canceled')`,
    ),
  ],
);
export const studyActivities = pgTable(
  "study_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    programId: uuid("program_id")
      .notNull()
      .references(() => studyPrograms.id),
    sessionId: uuid("session_id").references(() => studySessions.id),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    title: text("title").notNull(),
    instructions: text("instructions").notNull().default(""),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    latePolicy: text("late_policy").notNull().default("allow"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("study_late_policy", sql`${t.latePolicy} IN ('allow','block')`),
  ],
);
export const studySubmissionVersions = pgTable("study_submission_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  activityId: uuid("activity_id")
    .notNull()
    .references(() => studyActivities.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  body: text("body").notNull(),
  bodyDocument: text("body_document"),
  submittedAt: timestamp("submitted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studyAssets = pgTable("study_assets", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  originalName: text("original_name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storageBytes: integer("storage_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  previewKey: text("preview_key"),
  thumbnailKey: text("thumbnail_key"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const studySubmissionAssets = pgTable(
  "study_submission_assets",
  {
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => studySubmissionVersions.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => studyAssets.id),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.assetId] })],
);

export const studyDecks = pgTable("study_decks", {
  sessionId: uuid("session_id").references(() => studySessions.id),
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id")
    .notNull()
    .references(() => studyPrograms.id),
  sourceSubmissionId: uuid("source_submission_id").references(
    () => studySubmissionVersions.id,
  ),
  title: text("title").notNull().default("발표 자료"),
  state: text("state").notNull(),
  epoch: integer("epoch").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const studyDeckEditors = pgTable(
  "study_deck_editors",
  {
    deckId: uuid("deck_id")
      .notNull()
      .references(() => studyDecks.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.userId] })],
);
export const studyDeckVersions = pgTable("study_deck_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  deckId: uuid("deck_id")
    .notNull()
    .references(() => studyDecks.id),
  state: text("state").notNull(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const studySettings = pgTable("study_settings", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id),
  attendance: text("attendance").notNull(),
});
export const studyLiveRooms = pgTable("study_live_rooms", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => studySessions.id),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  originalHostId: uuid("original_host_id")
    .notNull()
    .references(() => users.id),
  hostId: uuid("host_id").references(() => users.id),
  presenterId: uuid("presenter_id").references(() => users.id),
  attendance: text("attendance").notNull(),
  shared: text("shared").notNull().default("{}"),
});
export const studyLiveConnections = pgTable("study_live_connections", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => studySessions.id),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  leftAt: timestamp("left_at", { withTimezone: true }),
});
export const studyLiveWaits = pgTable("study_live_waits", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => studySessions.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
export const studyDeckAssets = pgTable(
  "study_deck_assets",
  {
    deckId: uuid("deck_id")
      .notNull()
      .references(() => studyDecks.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => studyAssets.id),
  },
  (t) => [primaryKey({ columns: [t.deckId, t.assetId] })],
);

export const studyRoleDefaults = pgTable("study_role_defaults", {
  roleId: uuid("role_id")
    .primaryKey()
    .references(() => projectRoles.id),
  permissions: text("permissions").notNull(),
  templateVersion: integer("template_version").notNull().default(1),
});
export const studyAttendanceCorrections = pgTable(
  "study_attendance_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => studySessions.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    verdict: text("verdict").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "study_correction_verdict",
      sql`${t.verdict} IN ('present','absent','automatic')`,
    ),
  ],
);
