CREATE TABLE "task_attachments" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "task_id" uuid NOT NULL REFERENCES "project_tasks"("id") ON DELETE CASCADE,
 "name" text NOT NULL, "mime_type" text NOT NULL, "size" integer NOT NULL,
 "content" bytea NOT NULL,
 "created_by" uuid NOT NULL REFERENCES "users"("id"),
 "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "task_attachment_idx" ON "task_attachments"("task_id");
