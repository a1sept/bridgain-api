CREATE TABLE "task_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"head_sha" text DEFAULT '' NOT NULL,
	"base_sha" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "merge_approval_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "merge_reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "review_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "review_head_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "review_base_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "review_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "task_review_events" ADD CONSTRAINT "task_review_events_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_review_events" ADD CONSTRAINT "task_review_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_review_history_idx" ON "task_review_events" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_merge_reviewer_id_users_id_fk" FOREIGN KEY ("merge_reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_review_requested_by_users_id_fk" FOREIGN KEY ("review_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_approval_pr_unique" ON "project_tasks" USING btree ("pull_request_url") WHERE "project_tasks"."merge_approval_required" = true AND "project_tasks"."pull_request_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "task_review_status_check" CHECK ("project_tasks"."review_status" IN ('none','pending','approved','changes_requested','stale'));