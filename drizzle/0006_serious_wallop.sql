CREATE TABLE "ai_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"target_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_draft_kind_check" CHECK ("ai_drafts"."kind" IN ('note','task','meeting','result','document'))
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"client_id" uuid NOT NULL,
	"context" jsonb DEFAULT '{"commit":"","requestIds":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_message_role_check" CHECK ("ai_messages"."role" IN ('user','assistant','system'))
);
--> statement-breakpoint
CREATE TABLE "ai_session_requests" (
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	CONSTRAINT "ai_session_requests_session_id_request_id_pk" PRIMARY KEY("session_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"local_session_id" text,
	"commit" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_check" CHECK ("ai_sessions"."provider" IN ('codex','claude'))
);
--> statement-breakpoint
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_requests" ADD CONSTRAINT "ai_session_requests_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_requests" ADD CONSTRAINT "ai_session_requests_request_id_project_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."project_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_draft_session_idx" ON "ai_drafts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_message_client_idx" ON "ai_messages" USING btree ("session_id","client_id");--> statement-breakpoint
CREATE INDEX "ai_message_session_idx" ON "ai_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_session_owner_project_idx" ON "ai_sessions" USING btree ("owner_id","project_id","updated_at");