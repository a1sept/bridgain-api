CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"invitee_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "invitation_status_check" CHECK ("invitations"."status" IN ('pending','accepted','declined','canceled')),
	CONSTRAINT "invitation_not_self" CHECK ("invitations"."inviter_id" <> "invitations"."invitee_id")
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_access_check" CHECK ("project_memberships"."access_role" IN ('manager','contributor','client'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_status_check" CHECK ("projects"."status" IN ('preparing','in_progress','completed'))
);
--> statement-breakpoint
CREATE TABLE "team_member_positions" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"position" text NOT NULL,
	CONSTRAINT "team_member_positions_team_id_user_id_position_pk" PRIMARY KEY("team_id","user_id","position"),
	CONSTRAINT "team_position_check" CHECK ("team_member_positions"."position" IN ('planner','designer','developer'))
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission_role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memberships_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "team_permission_check" CHECK ("team_memberships"."permission_role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitee_id_users_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_member_positions" ADD CONSTRAINT "team_member_positions_team_id_user_id_team_memberships_team_id_user_id_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_memberships"("team_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_pending_unique" ON "invitations" USING btree ("project_id","invitee_id") WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invitation_invitee_idx" ON "invitations" USING btree ("invitee_id");--> statement-breakpoint
CREATE INDEX "project_member_user_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_team_idx" ON "projects" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_single_owner" ON "team_memberships" USING btree ("team_id") WHERE "team_memberships"."permission_role" = 'owner';--> statement-breakpoint
CREATE INDEX "team_member_user_idx" ON "team_memberships" USING btree ("user_id");