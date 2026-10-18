CREATE TABLE "project_stage_settings" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"stage_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"presets" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"predecessor_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_task_id_predecessor_id_pk" PRIMARY KEY("task_id","predecessor_id"),
	CONSTRAINT "task_dependency_self_check" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."predecessor_id")
);
--> statement-breakpoint
CREATE TABLE "task_deployment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"head_sha" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_work_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"head_sha" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_work_reviewers" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"acted_at" timestamp with time zone,
	CONSTRAINT "task_work_reviewers_task_id_user_id_pk" PRIMARY KEY("task_id","user_id"),
	CONSTRAINT "task_work_reviewer_status_check" CHECK ("task_work_reviewers"."status" IN ('pending','approved'))
);
--> statement-breakpoint
ALTER TABLE "project_tasks" DROP CONSTRAINT "task_status_check";--> statement-breakpoint
ALTER TABLE "meeting_requests" ADD COLUMN "stages" jsonb;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "stage_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "stage_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "stage_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "completion_mode" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "work_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "approved_head_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_assignees" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_stage_settings" ADD CONSTRAINT "project_stage_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_id_project_tasks_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_deployment_attempts" ADD CONSTRAINT "task_deployment_attempts_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_deployment_attempts" ADD CONSTRAINT "task_deployment_attempts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_events" ADD CONSTRAINT "task_work_events_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_events" ADD CONSTRAINT "task_work_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_reviewers" ADD CONSTRAINT "task_work_reviewers_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_work_reviewers" ADD CONSTRAINT "task_work_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_deployment_attempts_idx" ON "task_deployment_attempts" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_work_events_idx" ON "task_work_events" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "task_completion_mode_check" CHECK ("project_tasks"."completion_mode" IN ('document','design','code','test','deploy'));--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "task_status_check" CHECK ("project_tasks"."status" IN ('blocked','todo','in_progress','review_pending','done','deploy_pending','deploying','released'));