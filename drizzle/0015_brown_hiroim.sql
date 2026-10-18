CREATE TABLE "project_member_roles" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	CONSTRAINT "project_member_roles_project_id_user_id_role_id_pk" PRIMARY KEY("project_id","user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "project_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_role_name_unique" UNIQUE("project_id","name"),
	CONSTRAINT "project_role_project_id_unique" UNIQUE("project_id","id")
);
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "roles_configured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_member_roles" ADD CONSTRAINT "project_member_roles_project_id_user_id_project_memberships_project_id_user_id_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project_memberships"("project_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_roles" ADD CONSTRAINT "project_member_roles_project_id_role_id_project_roles_project_id_id_fk" FOREIGN KEY ("project_id","role_id") REFERENCES "public"."project_roles"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_roles" ADD CONSTRAINT "project_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;