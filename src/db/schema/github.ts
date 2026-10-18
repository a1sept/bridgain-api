import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
export const githubConnections = pgTable("github_connections", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const githubStates = pgTable("github_states", {
  state: text("state").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  verifier: text("verifier").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
