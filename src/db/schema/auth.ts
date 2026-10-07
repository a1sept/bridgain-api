import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
const date = (name: string) => timestamp(name, { withTimezone: true });
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull().unique(),
    displayName: text("display_name").notNull(),
    accountType: text("account_type").notNull(),
    status: text("status").notNull().default("active"),
    emailVerifiedAt: date("email_verified_at"),
    createdAt: date("created_at").notNull().defaultNow(),
    updatedAt: date("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "users_account_type_check",
      sql`${t.accountType} IN ('client','team')`,
    ),
    check(
      "users_status_check",
      sql`${t.status} IN ('active','suspended','deactivated')`,
    ),
  ],
);
export const passwordCredentials = pgTable("password_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: date("password_changed_at").notNull().defaultNow(),
});
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    appKind: text("app_kind").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    lastSeenAt: date("last_seen_at").notNull().defaultNow(),
    expiresAt: date("expires_at").notNull(),
    revokedAt: date("revoked_at"),
  },
  (t) => [
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_expiry_idx").on(t.expiresAt),
    check(
      "auth_sessions_app_check",
      sql`${t.appKind} IN ('client','developer')`,
    ),
    check("auth_sessions_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
// Retained for existing data; email verification and password reset are currently disabled.
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    appKind: text("app_kind").notNull(),
    createdAt: date("created_at").notNull().defaultNow(),
    expiresAt: date("expires_at").notNull(),
    consumedAt: date("consumed_at"),
  },
  (t) => [
    index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose),
    index("auth_tokens_expiry_idx").on(t.expiresAt),
    check(
      "auth_tokens_purpose_check",
      sql`${t.purpose} IN ('verify_email','reset_password')`,
    ),
    check("auth_tokens_app_check", sql`${t.appKind} IN ('client','developer')`),
    check("auth_tokens_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
