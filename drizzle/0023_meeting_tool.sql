ALTER TABLE "project_meetings" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_meetings" DROP CONSTRAINT IF EXISTS "meeting_status_check";--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "meeting_status_check" CHECK ("project_meetings"."status" IN ('scheduled','in_progress','completed'));--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD COLUMN IF NOT EXISTS "discussion_status" text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD COLUMN IF NOT EXISTS "final_approver_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
