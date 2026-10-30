CREATE TABLE "project_repository_managers" (
 "project_id" uuid NOT NULL REFERENCES "projects"("id"),
 "repository_url" text NOT NULL,
 "manager_user_id" uuid REFERENCES "users"("id"),
 PRIMARY KEY("project_id","repository_url")
);
--> statement-breakpoint
CREATE TABLE "repository_access_requests" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "project_id" uuid NOT NULL REFERENCES "projects"("id"),
 "repository_url" text NOT NULL,
 "requester_id" uuid NOT NULL REFERENCES "users"("id"),
 "manager_user_id" uuid REFERENCES "users"("id"),
 "note" text NOT NULL DEFAULT '',
 "status" text NOT NULL DEFAULT 'pending',
 "created_at" timestamptz NOT NULL DEFAULT now(),
 "resolved_at" timestamptz,
 "resolved_by" uuid REFERENCES "users"("id"),
 CONSTRAINT "repository_access_status" CHECK ("status" IN ('pending','resolved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_access_pending_unique" ON "repository_access_requests"("project_id","repository_url","requester_id") WHERE "status"='pending';
--> statement-breakpoint
CREATE INDEX "repository_access_project_time" ON "repository_access_requests"("project_id","created_at");
