ALTER TABLE "study_decks" ADD COLUMN "session_id" uuid REFERENCES "study_sessions"("id");
CREATE INDEX "study_decks_session_idx" ON "study_decks" ("session_id");
