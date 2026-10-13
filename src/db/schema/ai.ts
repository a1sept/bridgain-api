import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./workspace.js";
import { projectRequests } from "./requests.js";
export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    title: text("title").notNull(),
    localSessionId: text("local_session_id"),
    commit: text("commit").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_session_owner_project_idx").on(
      t.ownerId,
      t.projectId,
      t.updatedAt,
    ),
    check("ai_provider_check", sql`${t.provider} IN ('codex','claude')`),
  ],
);
export const aiSessionRequests = pgTable(
  "ai_session_requests",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSessions.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => projectRequests.id),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.requestId] })],
);
export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSessions.id),
    role: text("role").notNull(),
    body: text("body").notNull(),
    clientId: uuid("client_id").notNull(),
    context: jsonb("context")
      .$type<{ commit: string; requestIds: string[] }>()
      .notNull()
      .default({ commit: "", requestIds: [] }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_message_client_idx").on(t.sessionId, t.clientId),
    index("ai_message_session_idx").on(t.sessionId, t.createdAt),
    check(
      "ai_message_role_check",
      sql`${t.role} IN ('user','assistant','system')`,
    ),
  ],
);
export const aiDrafts = pgTable(
  "ai_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => aiSessions.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    targetId: uuid("target_id"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_draft_session_idx").on(t.sessionId, t.createdAt),
    check(
      "ai_draft_kind_check",
      sql`${t.kind} IN ('note','task','meeting','result','document')`,
    ),
  ],
);
