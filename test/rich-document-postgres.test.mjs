import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
test(
  "rich document migration preserves existing task text and persists structured contents",
  { skip: !process.env.CHANNEL_PGLITE_MODULE },
  async () => {
    const { PGlite } = await import(process.env.CHANNEL_PGLITE_MODULE);
    const pg = new PGlite();
    try {
      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      for (const entry of journal.entries.filter((e) => e.idx < 19))
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
            "utf8",
          ),
        );
      const user = randomUUID(),
        team = randomUUID(),
        project = randomUUID(),
        task = randomUUID();
      await pg.query(
        "INSERT INTO users(id,email,email_normalized,display_name,account_type) VALUES ($1,'rich@test.dev','rich@test.dev','test','team')",
        [user],
      );
      await pg.query(
        "INSERT INTO teams(id,name,created_by) VALUES ($1,'team',$2)",
        [team, user],
      );
      await pg.query(
        "INSERT INTO projects(id,team_id,name,created_by) VALUES ($1,$2,'project',$3)",
        [project, team, user],
      );
      const text = "기존 내용\n\n줄바꿈 유지";
      await pg.query(
        "INSERT INTO project_tasks(id,project_id,title,description,created_by) VALUES ($1,$2,'task',$3,$4)",
        [task, project, text, user],
      );
      for (const entry of journal.entries.filter((e) => e.idx >= 19))
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
            "utf8",
          ),
        );
      assert.deepEqual(
        (
          await pg.query(
            "SELECT description,description_document FROM project_tasks WHERE id=$1",
            [task],
          )
        ).rows[0],
        { description: text, description_document: null },
      );
      const document = {
        version: 1,
        blocks: [
          {
            id: "a",
            type: "paragraph",
            props: {},
            content: [{ type: "text", text, styles: { bold: true } }],
            children: [],
          },
        ],
      };
      await pg.query(
        "UPDATE project_tasks SET description_document=$1 WHERE id=$2",
        [JSON.stringify(document), task],
      );
      assert.deepEqual(
        (
          await pg.query(
            "SELECT description,description_document FROM project_tasks WHERE id=$1",
            [task],
          )
        ).rows[0],
        { description: text, description_document: document },
      );
    } finally {
      await pg.close();
    }
  },
);
