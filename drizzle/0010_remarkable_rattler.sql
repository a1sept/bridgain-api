CREATE TABLE "task_result_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"change_summary" text NOT NULL,
	"result_summary" text DEFAULT '' NOT NULL,
	"db_changes" text DEFAULT '' NOT NULL,
	"api_changes" text DEFAULT '' NOT NULL,
	"frontend_changes" text DEFAULT '' NOT NULL,
	"verification" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "version" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_result_entries" ADD CONSTRAINT "task_result_entries_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_result_entries" ADD CONSTRAINT "task_result_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_result_entries_idx" ON "task_result_entries" USING btree ("task_id","created_at");