import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { RequestsService } from '../dist/workspace/requests.service.js';
import { ProjectWorkService } from '../dist/workspace/project-work.service.js';

test('task sequence guards and task-scoped documents, memo and attachments persist safely', {skip: !process.env.ACTIVITY_PGLITE_MODULE}, async () => {
 const {PGlite}=await import(process.env.ACTIVITY_PGLITE_MODULE); const pg=new PGlite();
 try {
  const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const e of journal.entries) await pg.exec(await readFile(new URL(`../drizzle/${e.tag}.sql`,import.meta.url),'utf8'));
  const client={query:async(config,params)=>{const r=await pg.query(typeof config==='string'?config:config.text,params);return config.rowMode==='array'?{...r,rows:r.rows.map(Object.values)}:r;}};
  const db={db:drizzle(client)}; const requests=new RequestsService(db); const work=new ProjectWorkService(db,requests);
  const u={id:randomUUID(),displayName:'담당자',accountType:'team'}, outsider={id:randomUUID(),displayName:'외부',accountType:'team'};
  const team=randomUUID(),pid=randomUUID(),pid2=randomUUID(),first=randomUUID(),next=randomUUID(),last=randomUUID();
  for(const user of [u,outsider]) await pg.query("insert into users(id,email,email_normalized,display_name,account_type) values($1,$2,$2,$3,'team')",[user.id,`${user.id}@test.invalid`,user.displayName]);
  await pg.query("insert into teams(id,name,created_by) values($1,'team',$2)",[team,u.id]);
  await pg.query("insert into team_memberships(team_id,user_id,permission_role) values($1,$2,'owner')",[team,u.id]);
  for(const id of [pid,pid2]) {
   await pg.query("insert into projects(id,team_id,name,created_by) values($1,$2,'project',$3)",[id,team,u.id]);
   await pg.query("insert into project_memberships(project_id,user_id,access_role) values($1,$2,'manager')",[id,u.id]);
  }
  for(const id of [first,next,last]) {
   await pg.query("insert into project_tasks(id,project_id,title,created_by,stage_key,completion_mode,status) values($1,$2,'test',$3,$4,'document','todo')",[id,pid,u.id,id]);
   await pg.query('insert into task_assignees(task_id,user_id) values($1,$2)',[id,u.id]);
  }
  await pg.query('insert into task_dependencies(task_id,predecessor_id) values($1,$2),($3,$1)',[next,first,last]);
  const pdf={originalname:'기획.pdf',mimetype:'application/pdf',buffer:Buffer.from('%PDF-1.4\ntest'),size:13};pdf.size=pdf.buffer.length;
  const row=async id=>(await work.listTasks(u,pid)).tasks.find(t=>t.id===id);
  assert.equal((await row(next)).waitingForPredecessors,true);
  await assert.rejects(work.saveTask(u,pid,{expectedVersion:(await row(next)).version,status:'in_progress'},next),e=>e.response.code==='PREDECESSOR_REQUIRED');
  await assert.rejects(work.taskFiles(u,pid,next,[pdf]),e=>e.response.code==='PREDECESSOR_REQUIRED');
  await pg.query("update project_tasks set status='done' where id=$1",[first]);
  assert.equal((await row(next)).waitingForPredecessors,false);
  await work.saveTask(u,pid,{expectedVersion:(await row(next)).version,status:'in_progress',resultSummary:'작업 메모 보존'},next);
  assert.equal((await row(next)).resultSummary,'작업 메모 보존');
  await work.saveDocument(u,pid,{taskId:next,title:'기획 문서',content:'검색 조건과 완료 기준',category:'plan'});
  assert.equal((await row(next)).documentVersions[0].content,'검색 조건과 완료 기준');
  const uploaded=await work.taskFiles(u,pid,next,[pdf]);assert.equal(uploaded.attachments.length,1);
  const fid=uploaded.attachments[0].id;
  const downloaded=await work.taskFiles(u,pid,next,undefined,fid);assert.deepEqual(Buffer.from(downloaded.file.content),pdf.buffer);
  await assert.rejects(work.taskFiles(outsider,pid,next));
  await assert.rejects(work.taskFiles(u,pid2,next,undefined,fid));
  await assert.rejects(work.taskFiles(u,pid,first,undefined,fid));
  await assert.rejects(work.taskFiles(u,pid,next,[{...pdf,buffer:Buffer.from('fake'),size:4}]),e=>e.response.code==='INVALID_FILE');
  await work.taskFiles(u,pid,next,[pdf,pdf,pdf,pdf]);
  await assert.rejects(work.taskFiles(u,pid,next,[pdf]),e=>e.response.code==='FILE_LIMIT');
  await pg.query("update project_tasks set status='review_pending' where id=$1",[next]);
  await assert.rejects(work.taskFiles(u,pid,next,[pdf]),e=>e.response.code==='WORK_LOCKED');
  await pg.query("update project_tasks set status='done' where id=$1",[next]);
  assert.equal((await row(last)).waitingForPredecessors,false);
  await pg.query("update project_tasks set status='in_progress' where id=$1",[first]);
  assert.equal((await row(last)).waitingForPredecessors,true); // transitive rework blocks downstream
 } finally {await pg.close();}
});
