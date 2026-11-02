ALTER TABLE study_sessions ADD COLUMN series_id uuid;
ALTER TABLE study_sessions ADD COLUMN series_index integer;
ALTER TABLE study_sessions ADD COLUMN schedule_exception boolean NOT NULL DEFAULT false;
CREATE INDEX study_sessions_series ON study_sessions(program_id, series_id, series_index);
ALTER TABLE study_assets ADD COLUMN thumbnail_key text;
CREATE INDEX study_deck_versions_page ON study_deck_versions(deck_id, created_at DESC, id DESC);
CREATE INDEX study_sessions_page ON study_sessions(program_id, starts_at, id);
CREATE INDEX study_activities_page ON study_activities(program_id, due_at, id);
