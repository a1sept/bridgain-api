import { sql } from "drizzle-orm";
import type { DatabaseService } from "../db/database.service.js";
import { requestEvents } from "../db/schema/requests.js";

type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];
export async function recordRequestHandler(
  tx: Tx,
  requestId: string,
  user: { id: string; displayName: string },
  source: "meeting" | "urgent",
) {
  await tx.insert(requestEvents).values({
    requestId,
    kind: "handler_assignment",
    actorId: user.id,
    body: `요청 처리 담당자: ${user.displayName} · ${source === "meeting" ? "회의 연결" : "긴급 승인 요청"}`,
    createdAt: sql`clock_timestamp()`,
  });
}
