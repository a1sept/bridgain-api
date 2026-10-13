CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"url" text,
	"change_summary" text NOT NULL,
	"task_id" uuid,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_requests" (
	"meeting_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"planning" text DEFAULT '' NOT NULL,
	"ui_notes" text DEFAULT '' NOT NULL,
	"api_notes" text DEFAULT '' NOT NULL,
	"db_notes" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"task_id" uuid,
	CONSTRAINT "meeting_requests_meeting_id_request_id_pk" PRIMARY KEY("meeting_id","request_id"),
	CONSTRAINT "meeting_request_priority_check" CHECK ("meeting_requests"."priority" IN ('urgent','high','normal','low'))
);
--> statement-breakpoint
ALTER TABLE "project_documents" DROP CONSTRAINT "document_category_check";--> statement-breakpoint
ALTER TABLE "project_tasks" DROP CONSTRAINT "task_status_check";--> statement-breakpoint
ALTER TABLE "project_meetings" ADD COLUMN "decision_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "repository_url" text;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "work_branch" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "live_branch" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "merge_commit" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "deployment_url" text;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "result_summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "db_changes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "api_changes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "frontend_changes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "verification" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_project_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."project_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD CONSTRAINT "meeting_requests_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD CONSTRAINT "meeting_requests_request_id_project_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."project_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD CONSTRAINT "meeting_requests_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_version_idx" ON "document_versions" USING btree ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "document_category_check" CHECK ("project_documents"."category" IN ('plan','design','api','meeting','erd','frontend','other'));--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "meeting_decision_check" CHECK ("project_meetings"."decision_status" IN ('draft','final'));--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "task_status_check" CHECK ("project_tasks"."status" IN ('todo','in_progress','done','released'));
--> statement-breakpoint
INSERT INTO "meeting_requests" ("meeting_id", "request_id")
SELECT "id", "request_id" FROM "project_meetings" WHERE "request_id" IS NOT NULL
ON CONFLICT DO NOTHING;
