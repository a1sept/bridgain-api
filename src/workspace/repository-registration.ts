import { sql } from "drizzle-orm";
import type { DatabaseService } from "../db/database.service.js";
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
// Only authenticated server actors are accepted. Normal settings saves never replace provenance.
export async function recordRepositoryRegistrations(
  tx: Tx,
  projectId: string,
  actorId: string,
  previous: string[],
  next: string[],
) {
  const known = new Set(previous.map((url) => url.toLowerCase()));
  for (const url of next) {
    if (known.has(url.toLowerCase())) continue;
    await tx.execute(
      sql`INSERT INTO project_repository_registrations(project_id,repository_url,registered_by) VALUES(${projectId},${url.toLowerCase()},${actorId}) ON CONFLICT(project_id,repository_url) DO UPDATE SET registered_by=EXCLUDED.registered_by,registered_at=clock_timestamp()`,
    );
  }
}
