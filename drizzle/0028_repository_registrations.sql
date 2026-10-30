-- Existing repositories have unknown provenance. Do not relabel a manual manager
-- or project creator as their registrant. Runtime explicitly labels creator fallback.
CREATE TABLE "project_repository_registrations" (
 "project_id" uuid NOT NULL REFERENCES "projects"("id"),
 "repository_url" text NOT NULL,
 "registered_by" uuid NOT NULL REFERENCES "users"("id"),
 "registered_at" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY("project_id","repository_url")
);
