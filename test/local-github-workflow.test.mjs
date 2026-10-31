import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { StagedWorkService } from "../dist/workspace/staged-work.service.js";

for (const serverAuth of [false, true]) test(`GitHub PR lifecycle: SHA validation, rework, approval and deployment with user credentials ${serverAuth ? "despite legacy server settings" : "without server settings"}`, { skip: !process.env.WORKFLOW_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.WORKFLOW_PGLITE_MODULE);
  const pg = new PGlite();
  const oldFetch = global.fetch, oldGrants = process.env.GITHUB_PROJECT_REPOSITORIES, oldToken = process.env.GITHUB_MERGE_TOKEN;
  try {
    const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
    for (const e of journal.entries) await pg.exec(await readFile(new URL(`../drizzle/${e.tag}.sql`, import.meta.url), "utf8"));
    const client = { query: async (config, params) => { const r = await pg.query(typeof config === "string" ? config : config.text, params); return config.rowMode === "array" ? { ...r, rows: r.rows.map(Object.values) } : r; } };
    const database = { db: drizzle(client) };
    const worker = { id: randomUUID(), displayName: "Worker", accountType: "team" }, reviewer = { id: randomUUID(), displayName: "Reviewer", accountType: "team" };
    for (const u of [worker, reviewer]) await pg.query("insert into users(id,email,email_normalized,display_name,account_type) values($1,$2,$2,$3,'team')", [u.id, `${u.id}@example.test`, u.displayName]);
    const team = randomUUID(), pid = randomUUID(), id = randomUUID(), repo = "https://github.com/example/project";
    await pg.query("insert into teams(id,name,created_by) values($1,'Team',$2)", [team, reviewer.id]);
    await pg.query("insert into projects(id,team_id,name,created_by,repository_urls) values($1,$2,'Project',$3,ARRAY[$4])", [pid, team, reviewer.id, repo]);
    await pg.query("insert into project_tasks(id,project_id,title,created_by,stage_key,completion_mode,status,repository_url,work_branch) values($1,$2,'Code task',$3,'code','code','in_progress',$4,'task/142')", [id,pid,worker.id,repo]);
    await pg.query("insert into task_assignees(task_id,user_id) values($1,$2)", [id, worker.id]);
    await pg.query("insert into task_work_reviewers(task_id,user_id) values($1,$2)", [id, reviewer.id]);
    let sha = "a".repeat(40), pr, created = 0, merged = 0, injectFailure = true;
    const calls = [];
    let connected = false;
    const connection = { status: async () => ({ connected }), repositoryRequest: async (uid, repository, suffix, method = "GET", body) => {
      calls.push({uid,suffix,method}); assert.equal(repository, repo);
      if (suffix.startsWith("/git/ref/")) return { object: { sha } };
      if (suffix.startsWith("/pulls?")) return pr ? [pr] : [];
      if (suffix === "/pulls" && method === "POST") {
        created++; pr = { html_url: repo+"/pull/87", state:"open", merged:false, draft:false, head:{sha,ref:"task/142",repo:{html_url:repo}},base:{sha:"0".repeat(40),ref:"main",repo:{html_url:repo}} };
        // Simulate GitHub accepting the request, then the network losing its response.
        if (injectFailure) { injectFailure = false; throw Error("response lost"); }
        return pr;
      }
      if (suffix === "/pulls/87") return pr;
      if (suffix.startsWith("/pulls/87/files?")) return [{ filename: "file.ts", status:"modified", patch:"+ changed" }];
      if (suffix === "/pulls/87/merge") { assert.equal(uid,reviewer.id); assert.equal(body.sha,sha); merged++;pr.merged=true;pr.merge_commit_sha="c".repeat(40);return {merged:true,sha:pr.merge_commit_sha}; }
      throw Error(`Unexpected ${method} ${suffix}`);
    } };
    const requests = { access: async (_tx,u) => ({ isDeveloper:true,permissions: u.id === reviewer.id ? ["tasks.read","approvals.work","deploy.run"] : ["tasks.read","tasks.progress"] }) };
    if (serverAuth) {
      process.env.GITHUB_PROJECT_REPOSITORIES = JSON.stringify({ [pid]: [repo] });
      process.env.GITHUB_MERGE_TOKEN = "server-test";
      global.fetch = async () => { throw Error("Server authentication must not be used"); };
    }
    const service = new StagedWorkService(database, requests, connection);
    const task = async () => (await pg.query("select * from project_tasks where id=$1",[id])).rows[0];
    await assert.rejects(service.gitContext(reviewer,pid,id,true), e=>e.getStatus()===403);
    await assert.rejects(service.submitPr(worker,pid,id,{headSha:sha,expectedRevision:1}), e=>e.response.code==="GITHUB_CONNECT_REQUIRED");
    assert.equal(created,0); connected=true;
    await assert.rejects(service.submitPr(worker,pid,id,{headSha:"b".repeat(40),expectedRevision:1}),e=>e.getStatus()===409);
    assert.equal(created,0);
    const submitted = await service.submitPr(worker,pid,id,{headSha:sha,expectedRevision:1});
    assert.equal(submitted.pullRequestUrl,repo+"/pull/87");assert.equal(created,1);assert.equal((await task()).status,"review_pending");
    assert.equal((await service.remoteCode(reviewer,pid,id)).files[0].diff,"+ changed");
    connected=false;
    await assert.rejects(service.act(reviewer,pid,id,{action:"approve",expectedHeadSha:sha,expectedRevision:1}), e=>e.response.code==="GITHUB_CONNECT_REQUIRED");
    assert.equal(merged,0); assert.equal((await task()).status,"review_pending"); connected=true;
    await service.act(reviewer,pid,id,{action:"changes_requested",note:"Please fix",expectedRevision:1});
    assert.equal((await task()).status,"in_progress");assert.equal((await task()).pull_request_url,repo+"/pull/87");
    sha="b".repeat(40);pr.head.sha=sha;
    await service.submitPr(worker,pid,id,{headSha:sha,expectedRevision:(await task()).work_revision});assert.equal(created,1);
    await service.act(reviewer,pid,id,{action:"approve",expectedHeadSha:sha,expectedRevision:(await task()).work_revision});
    assert.equal((await task()).status,"deploy_pending");assert.equal(merged,1);
    await service.deploy(reviewer,pid,{taskIds:[id]});
    assert.equal(merged,1);assert.equal((await task()).status,"deploying");
    assert.ok(calls.some(c=>c.uid===worker.id&&c.method==="POST"));
  } finally {
    global.fetch = oldFetch;
    oldGrants === undefined ? delete process.env.GITHUB_PROJECT_REPOSITORIES : process.env.GITHUB_PROJECT_REPOSITORIES = oldGrants;
    oldToken === undefined ? delete process.env.GITHUB_MERGE_TOKEN : process.env.GITHUB_MERGE_TOKEN = oldToken;
    await pg.close();
  }
});
