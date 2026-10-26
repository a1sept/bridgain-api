CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"body" text NOT NULL,
	"parent_key" text,
	"target_kind" text,
	"target_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_target_check" CHECK (("channel_messages"."target_kind" IS NULL AND "channel_messages"."target_id" IS NULL) OR ("channel_messages"."target_kind" IS NOT NULL AND "channel_messages"."target_kind" IN ('task','meeting') AND "channel_messages"."target_id" IS NOT NULL)),
	CONSTRAINT "channel_body_check" CHECK (length(trim("channel_messages"."body")) BETWEEN 1 AND 5000)
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_project_time_idx" ON "channel_messages" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_thread_idx" ON "channel_messages" USING btree ("project_id","parent_key");