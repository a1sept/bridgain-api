ALTER TABLE "project_roles" ADD COLUMN "color" text DEFAULT '#2D63ED' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_role_color_check" CHECK ("project_roles"."color" ~ '^#[0-9A-Fa-f]{6}$');
--> statement-breakpoint
-- Existing roles have no chosen color yet: assign the UI palette per project.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS ordinal
  FROM project_roles
)
UPDATE project_roles AS role
SET color = (ARRAY['#2D63ED','#7C3AED','#0891B2','#059669','#D97706','#DC2626','#DB2777','#64748B'])[((ranked.ordinal - 1) % 8 + 1)::integer]
FROM ranked
WHERE role.id = ranked.id;
