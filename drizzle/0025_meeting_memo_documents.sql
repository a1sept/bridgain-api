ALTER TABLE "project_meetings" ADD COLUMN "notes_document" jsonb;
--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD COLUMN "planning_document" jsonb;
