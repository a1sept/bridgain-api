CREATE TABLE "request_workflow_links" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"meeting_id" uuid,
	"approval_id" uuid,
	"task_id" uuid
);
--> statement-breakpoint
CREATE TABLE "task_approval_reviewers" (
	"approval_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"acted_at" timestamp with time zone,
	CONSTRAINT "task_approval_reviewers_approval_id_user_id_pk" PRIMARY KEY("approval_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "task_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"meeting_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"plans" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_source_check" CHECK ("task_approvals"."source" IN ('meeting','urgent')),
	CONSTRAINT "approval_status_check" CHECK ("task_approvals"."status" IN ('pending','approved','rejected','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "project_memberships" ADD COLUMN "can_approve_tasks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_requests" ADD COLUMN "origin" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD COLUMN "approval_id" uuid;--> statement-breakpoint
ALTER TABLE "request_workflow_links" ADD CONSTRAINT "request_workflow_links_request_id_project_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."project_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_workflow_links" ADD CONSTRAINT "request_workflow_links_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_workflow_links" ADD CONSTRAINT "request_workflow_links_approval_id_task_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."task_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_workflow_links" ADD CONSTRAINT "request_workflow_links_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approval_reviewers" ADD CONSTRAINT "task_approval_reviewers_approval_id_task_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."task_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approval_reviewers" ADD CONSTRAINT "task_approval_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_approvals" ADD CONSTRAINT "task_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "request_origin_check" CHECK ("project_requests"."origin" IN ('customer','development'));--> statement-breakpoint
-- Keep legacy meeting/task rows intact. Pick a deterministic current association;
-- old duplicate task records continue to block another conversion in application checks.
INSERT INTO request_workflow_links (request_id, meeting_id, task_id)
SELECT r.id,
 (SELECT mr.meeting_id FROM meeting_requests mr JOIN project_meetings m ON m.id=mr.meeting_id WHERE mr.request_id=r.id ORDER BY (mr.task_id IS NOT NULL) DESC,m.created_at DESC,m.id LIMIT 1),
 (SELECT tr.task_id FROM task_requests tr JOIN project_tasks t ON t.id=tr.task_id WHERE tr.request_id=r.id ORDER BY t.created_at,t.id LIMIT 1)
FROM project_requests r
WHERE EXISTS(SELECT 1 FROM meeting_requests mr WHERE mr.request_id=r.id) OR EXISTS(SELECT 1 FROM task_requests tr WHERE tr.request_id=r.id)
ON CONFLICT (request_id) DO NOTHING;
--> statement-breakpoint
-- Older meetings used only request_id. Preserve and claim those links too.
INSERT INTO request_workflow_links (request_id, meeting_id)
SELECT DISTINCT ON (m.request_id) m.request_id, m.id
FROM project_meetings m WHERE m.request_id IS NOT NULL
ORDER BY m.request_id, (m.decision_status='final') DESC, m.created_at DESC, m.id
ON CONFLICT (request_id) DO NOTHING;
