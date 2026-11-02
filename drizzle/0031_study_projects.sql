ALTER TABLE projects ADD COLUMN kind text NOT NULL DEFAULT 'development';
ALTER TABLE projects ADD CONSTRAINT project_kind_check CHECK (kind IN ('development','study'));
CREATE TABLE study_programs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id),
 planned_session_count integer CHECK(planned_session_count BETWEEN 1 AND 500), title text NOT NULL, description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'preparing',
 membership_mode text NOT NULL DEFAULT 'all', created_by uuid NOT NULL REFERENCES users(id),
 started_at timestamptz, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT study_program_status CHECK(status IN ('preparing','active','completed')),
 CONSTRAINT study_program_membership CHECK(membership_mode IN ('all','selected'))
);
CREATE INDEX study_program_project ON study_programs(project_id);
CREATE TABLE study_program_members(left_at timestamptz,program_id uuid NOT NULL REFERENCES study_programs(id), user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(program_id,user_id));
CREATE TABLE study_organizers(program_id uuid NOT NULL REFERENCES study_programs(id),user_id uuid NOT NULL REFERENCES users(id),role text NOT NULL DEFAULT 'host',PRIMARY KEY(program_id,user_id),CONSTRAINT study_organizer_role CHECK(role IN ('host','deputy')));
CREATE TABLE study_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),program_id uuid NOT NULL REFERENCES study_programs(id),title text NOT NULL,starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, location text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'scheduled',CONSTRAINT study_session_times CHECK(ends_at>starts_at),CONSTRAINT study_session_status CHECK(status IN ('scheduled','live','ended','canceled')));
CREATE INDEX study_session_program ON study_sessions(program_id);
CREATE TABLE study_activities(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),program_id uuid NOT NULL REFERENCES study_programs(id),session_id uuid REFERENCES study_sessions(id),archived_at timestamptz,title text NOT NULL,instructions text NOT NULL DEFAULT '',due_at timestamptz NOT NULL,late_policy text NOT NULL DEFAULT 'allow',created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT study_late_policy CHECK(late_policy IN ('allow','block')));
CREATE INDEX study_activity_program ON study_activities(program_id);
CREATE TABLE study_submission_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),activity_id uuid NOT NULL REFERENCES study_activities(id),user_id uuid NOT NULL REFERENCES users(id),deadline_at timestamptz NOT NULL,body text NOT NULL,body_document text,submitted_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX study_submission_activity_user ON study_submission_versions(activity_id,user_id,submitted_at);

CREATE TABLE study_assets(id uuid PRIMARY KEY,project_id uuid NOT NULL REFERENCES projects(id),owner_id uuid NOT NULL REFERENCES users(id),original_name text NOT NULL,mime text NOT NULL,size integer NOT NULL,storage_bytes integer NOT NULL,storage_key text NOT NULL,preview_key text,last_used_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE study_submission_assets(submission_id uuid NOT NULL REFERENCES study_submission_versions(id),asset_id uuid NOT NULL REFERENCES study_assets(id),PRIMARY KEY(submission_id,asset_id));

CREATE TABLE study_decks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),program_id uuid NOT NULL REFERENCES study_programs(id),source_submission_id uuid REFERENCES study_submission_versions(id),title text NOT NULL DEFAULT '발표 자료',state text NOT NULL,epoch integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE study_deck_editors(deck_id uuid NOT NULL REFERENCES study_decks(id),user_id uuid NOT NULL REFERENCES users(id),PRIMARY KEY(deck_id,user_id));
CREATE TABLE study_deck_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),deck_id uuid NOT NULL REFERENCES study_decks(id),state text NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE study_settings(project_id uuid PRIMARY KEY REFERENCES projects(id),attendance text NOT NULL);
CREATE TABLE study_live_rooms(session_id uuid PRIMARY KEY REFERENCES study_sessions(id),started_at timestamptz NOT NULL DEFAULT now(),ended_at timestamptz,original_host_id uuid NOT NULL REFERENCES users(id),host_id uuid REFERENCES users(id),presenter_id uuid REFERENCES users(id),attendance text NOT NULL,shared text NOT NULL DEFAULT '{}');
CREATE TABLE study_live_connections(id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES study_sessions(id),user_id uuid NOT NULL REFERENCES users(id),joined_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),left_at timestamptz);
CREATE INDEX study_live_connection_session ON study_live_connections(session_id);
CREATE TABLE study_live_waits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES study_sessions(id),started_at timestamptz NOT NULL,ended_at timestamptz);
CREATE INDEX study_live_wait_session ON study_live_waits(session_id);
CREATE TABLE study_deck_assets(deck_id uuid NOT NULL REFERENCES study_decks(id),asset_id uuid NOT NULL REFERENCES study_assets(id),PRIMARY KEY(deck_id,asset_id));

CREATE TABLE study_role_defaults(role_id uuid PRIMARY KEY REFERENCES project_roles(id),permissions text NOT NULL,template_version integer NOT NULL DEFAULT 1);
CREATE TABLE study_attendance_corrections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES study_sessions(id),user_id uuid NOT NULL REFERENCES users(id),actor_id uuid NOT NULL REFERENCES users(id),verdict text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT study_correction_verdict CHECK(verdict IN ('present','absent','automatic')));
