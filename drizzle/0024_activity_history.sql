CREATE TABLE IF NOT EXISTS "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"meeting_id" uuid,
	"task_id" uuid,
	"request_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"source_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='activity_events_project_id_projects_id_fk' AND conrelid='activity_events'::regclass) THEN
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_source_key_idx" ON "activity_events" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_feed_idx" ON "activity_events" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_project_feed_idx" ON "activity_events" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_requests_idx" ON "activity_events" USING gin ("request_ids");--> statement-breakpoint
--> statement-breakpoint
-- Preserve only recorded events. Unknown historic meeting/request links stay unknown.
INSERT INTO activity_events (project_id,kind,category,title,actor_id,actor_name,request_ids,requests,source_key,occurred_at)
SELECT r.project_id,'request_created','request',r.title,e.actor_id,coalesce(u.display_name,'탈퇴한 사용자'),ARRAY[r.id],jsonb_build_array(jsonb_build_object('id',r.id,'title',r.title,'origin',r.origin)),'request:'||r.id||':created',e.created_at
FROM request_events e JOIN project_requests r ON r.id=e.request_id LEFT JOIN users u ON u.id=e.actor_id WHERE e.kind='created'
ON CONFLICT (source_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO activity_events (project_id,kind,category,title,actor_id,actor_name,meeting_id,task_id,source_key,occurred_at,body)
SELECT a.project_id,CASE a.kind WHEN 'meeting_created' THEN 'meeting_scheduled' WHEN 'task_created' THEN 'task_assigned' ELSE a.kind END,CASE WHEN a.kind LIKE 'meeting_%' THEN 'meeting' ELSE 'task' END,a.body,a.actor_id,coalesce(u.display_name,'탈퇴한 사용자'),CASE WHEN a.kind LIKE 'meeting_%' THEN a.entity_id END,CASE WHEN a.kind LIKE 'task_%' THEN a.entity_id END,'legacy-project:'||a.id,a.created_at,'기존 기록 · 당시 연결 정보는 저장되지 않았습니다.'
FROM project_activity a LEFT JOIN users u ON u.id=a.actor_id WHERE a.kind IN ('meeting_created','meeting_started','meeting_completed','task_created')
ON CONFLICT (source_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO activity_events (project_id,kind,category,title,body,actor_id,actor_name,task_id,request_ids,requests,source_key,occurred_at)
SELECT t.project_id,CASE e.action WHEN 'completed' THEN 'task_completed' WHEN 'approved' THEN 'task_approved' WHEN 'deploy_started' THEN 'deploy_ready' WHEN 'released' THEN 'deploy_completed' WHEN 'changes_requested' THEN 'task_changes_requested' ELSE 'task_invalidated' END,CASE WHEN e.action IN ('deploy_started','released') THEN 'deployment' ELSE 'task' END,t.title,e.note,e.actor_id,coalesce(u.display_name,'탈퇴한 사용자'),t.id,
coalesce((SELECT array_agg(r.id) FROM task_requests tr JOIN project_requests r ON r.id=tr.request_id WHERE tr.task_id=t.id),'{}'::uuid[]),
coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'origin',r.origin)) FROM task_requests tr JOIN project_requests r ON r.id=tr.request_id WHERE tr.task_id=t.id),'[]'::jsonb),'work:'||e.id,e.created_at
FROM task_work_events e JOIN project_tasks t ON t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_id
ON CONFLICT (source_key) DO NOTHING;
--> statement-breakpoint
-- All request creation paths (including AI drafts) share the same authoritative event.
CREATE OR REPLACE FUNCTION record_request_created_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO activity_events(project_id,kind,category,title,actor_id,actor_name,request_ids,requests,source_key,occurred_at)
 VALUES(NEW.project_id,'request_created','request',NEW.title,NEW.created_by,coalesce((SELECT display_name FROM users WHERE id=NEW.created_by),'탈퇴한 사용자'),ARRAY[NEW.id],jsonb_build_array(jsonb_build_object('id',NEW.id,'title',NEW.title,'origin',NEW.origin)),'request:'||NEW.id||':created',NEW.created_at)
 ON CONFLICT(source_key) DO NOTHING;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS request_created_activity ON project_requests;
--> statement-breakpoint
CREATE TRIGGER request_created_activity AFTER INSERT ON project_requests FOR EACH ROW EXECUTE FUNCTION record_request_created_activity();

--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "occurred_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "occurred_at" SET DEFAULT now();
