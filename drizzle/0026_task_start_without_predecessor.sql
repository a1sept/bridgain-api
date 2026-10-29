UPDATE "project_tasks"
SET "status" = 'todo', "version" = gen_random_uuid(), "updated_at" = clock_timestamp()
WHERE "status" = 'blocked';
--> statement-breakpoint
ALTER TABLE "project_tasks" DROP CONSTRAINT "task_status_check";
--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "task_status_check"
CHECK ("status" IN ('todo','in_progress','review_pending','done','deploy_pending','deploying','released'));
