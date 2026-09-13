import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Technical metadata only. Business tables are added with reviewed migrations later.
export const appMetadata = pgTable('app_metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
