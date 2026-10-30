import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { RequestsService } from "../dist/workspace/requests.service.js";
import { ProjectWorkService } from "../dist/workspace/project-work.service.js";
test(
  "meeting tool: metadata round trip, legacy defaults and project boundary",
  { skip: !process.env.MEETING_PGLITE_MODULE },
  async () => {
    const { PGlite } = await import(process.env.MEETING_PGLITE_MODULE);
    const pg = new PGlite();
    try {
      const journal = JSON.parse(
        await readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
      );
      for (const entry of journal.entries)
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
            "utf8",
          ),
        );
      const client = {
        query: async (config, params) => {
          const r = await pg.query(
            typeof config === "string" ? config : config.text,
            params,
          );
          return config.rowMode === "array"
            ? { ...r, rows: r.rows.map((row) => Object.values(row)) }
            : r;
        },
      };
      const db = { db: drizzle(client) };
      const requests = new RequestsService(db),
        work = new ProjectWorkService(db, requests);
      const owner = {
          id: randomUUID(),
          displayName: "관리자",
          accountType: "team",
        },
        worker = {
          id: randomUUID(),
          displayName: "담당자",
          accountType: "team",
        },
        outsider = {
          id: randomUUID(),
          displayName: "외부",
          accountType: "team",
        };
      const team = randomUUID(),
        pid = randomUUID(),
        pid2 = randomUUID();
      for (const u of [owner, worker, outsider])
        await pg.query(
          "insert into users(id,email,email_normalized,display_name,account_type) values($1,$2,$2,$3,'team')",
          [u.id, `${u.id}@test.invalid`, u.displayName],
        );
      await pg.query("insert into teams(id,name,created_by) values($1,$2,$3)", [
        team,
        "검증 팀",
        owner.id,
      ]);
      for (const [u, role] of [
        [owner, "owner"],
        [worker, "member"],
      ])
        await pg.query(
          "insert into team_memberships(team_id,user_id,permission_role) values($1,$2,$3)",
          [team, u.id, role],
        );
      for (const id of [pid, pid2]) {
        await pg.query(
          "insert into projects(id,team_id,name,created_by) values($1,$2,$3,$4)",
          [id, team, "프로젝트", owner.id],
        );
        await pg.query(
          "insert into project_memberships(project_id,user_id,access_role) values($1,$2,'manager')",
          [id, owner.id],
        );
      }
      await pg.query(
        "insert into project_memberships(project_id,user_id,access_role) values($1,$2,'contributor')",
        [pid, worker.id],
      );
      const create = async (title, p = pid) =>
        (
          await requests.create(owner, p, {
            title,
            description: "설명",
            priority: "normal",
            type: "feature",
          })
        ).request;
      const request = await create("새 안건");
      const meeting = (await work.saveMeeting(owner,pid,{title:"회의 툴",scheduledAt:"2026-10-30T02:00:00Z",finalApproverIds:[worker.id],requests:[{requestId:request.id,discussionStatus:"deferred",planning:"확인 후 재논의"}]})).meeting;
      let saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.deepEqual(saved.finalApproverIds,[worker.id]);
      assert.equal(saved.requests[0].discussionStatus,"deferred");
      await work.saveMeeting(owner,pid,{notes:"전체 메모"},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.deepEqual(saved.finalApproverIds,[worker.id]);
      assert.equal(saved.requests[0].discussionStatus,"deferred");
      const deadlineStage = {id:"deadline",name:"기획",title:"기한 업무",brief:"할 일",completionMode:"document",assigneeIds:[worker.id],reviewerIds:[owner.id],dependsOn:[],dueDate:"2026-11-15"};
      await work.saveMeeting(owner,pid,{requests:[{requestId:request.id,stages:[deadlineStage]}]},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.equal(saved.requests[0].stages[0].dueDate,"2026-11-15");
      await work.saveMeeting(owner,pid,{notes:"일정 유지"},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.equal(saved.requests[0].stages[0].dueDate,"2026-11-15");
      const memo = (text) => ({version:1,blocks:[{id:"memo",type:"bulletListItem",props:{},content:[{type:"text",text,styles:{bold:true}}],children:[]}]});
      const notesDocument = memo("회의 결론"), planningDocument = memo("요청 논의");
      await work.saveMeeting(owner,pid,{notesDocument,requests:[{requestId:request.id,planningDocument}]},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.deepEqual(saved.notesDocument,notesDocument);
      assert.equal(saved.notes,"회의 결론");
      assert.deepEqual(saved.requests[0].planningDocument,planningDocument);
      assert.equal(saved.requests[0].planning,"요청 논의");
      await work.saveMeeting(owner,pid,{notes:"회의 결론",requests:[{requestId:request.id,planning:"요청 논의"}]},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.deepEqual(saved.notesDocument,notesDocument);
      assert.deepEqual(saved.requests[0].planningDocument,planningDocument);
      await work.saveMeeting(owner,pid,{notes:"기존 클라이언트 수정",requests:[{requestId:request.id,planning:"일반 메모 수정"}]},meeting.id);
      saved = (await work.listMeetings(owner,pid)).meetings.find(m=>m.id===meeting.id);
      assert.equal(saved.notesDocument,null);
      assert.equal(saved.requests[0].planningDocument,null);
      assert.equal(saved.notes,"기존 클라이언트 수정");
      await work.saveMeeting(owner,pid,{notesDocument:memo("가".repeat(15000))},meeting.id);
      await assert.rejects(work.saveMeeting(owner,pid,{notesDocument:memo("가".repeat(20001))},meeting.id),e=>e.getStatus()===400);
      await assert.rejects(work.saveMeeting(owner,pid,{requests:[{requestId:request.id,planningDocument:memo("가".repeat(10001))}]},meeting.id),e=>e.getStatus()===400);
      await assert.rejects(work.saveMeeting(owner,pid,{notesDocument:{version:1,blocks:[{id:"bad",type:"script"}]}},meeting.id),e=>e.getStatus()===400);
      await assert.rejects(work.saveMeeting(owner,pid,{finalApproverIds:[outsider.id]},meeting.id), e=>e.getStatus()===400);
      await assert.rejects(work.saveMeeting(owner,pid,{requests:[{requestId:request.id,discussionStatus:"invalid"}]},meeting.id),e=>e.getStatus()===400);
      const legacy=(await work.saveMeeting(owner,pid,{title:"이전 클라이언트",scheduledAt:"2026-10-30T02:00:00Z"})).meeting;
      assert.deepEqual(legacy.finalApproverIds,[]);
      await assert.rejects(work.meetingAction(owner,pid,legacy.id,{action:"complete"}),e=>e.getStatus()===409);
      const started=(await work.meetingAction(owner,pid,legacy.id,{action:"start"})).meeting;
      assert.equal(started.status,"in_progress");
      assert(started.startedAt);
      assert.equal((await work.listMeetings(owner,pid)).meetings.find(m=>m.id===legacy.id).status,"in_progress");
      assert.equal((await work.meetingAction(owner,pid,legacy.id,{action:"start"})).meeting.status,"in_progress");
      const completed=(await work.meetingAction(owner,pid,legacy.id,{action:"complete"})).meeting;
      assert.equal(completed.status,"completed");
      assert(completed.endedAt);
      assert.equal(completed.decisionStatus,"draft");
      await assert.rejects(work.meetingAction(owner,pid,legacy.id,{action:"start"}),e=>e.getStatus()===409);
      await assert.rejects(work.meetingAction(outsider,pid,legacy.id,{action:"reopen"}));
      await pg.query("UPDATE project_meetings SET decision_status='final' WHERE id=$1",[legacy.id]);
      const reopened=(await work.meetingAction(owner,pid,legacy.id,{action:"reopen"})).meeting;
      assert.equal(reopened.status,"in_progress");
      assert.equal(reopened.endedAt,null);
      assert.equal(reopened.decisionStatus,"final");
      assert.deepEqual(reopened.startedAt,started.startedAt);
      await work.meetingAction(owner,pid,legacy.id,{action:"reopen"});
      await work.meetingAction(owner,pid,legacy.id,{action:"complete"});
      const events=await pg.query("SELECT kind FROM activity_events WHERE meeting_id=$1 AND kind IN ('meeting_reopened','meeting_completed')",[legacy.id]);
      assert.equal(events.rows.filter(e=>e.kind==='meeting_reopened').length,1);
      assert.equal(events.rows.filter(e=>e.kind==='meeting_completed').length,2);


      const second = await create("순서2"), third = await create("순서3");
      const order = [third.id, request.id, second.id];
      await work.saveMeeting(owner, pid, { requests: order.map(requestId => ({ requestId })) }, meeting.id);
      const reordered = (await work.listMeetings(owner, pid)).meetings.find(m => m.id === meeting.id);
      assert.deepEqual(reordered.requests.map(r => r.requestId), order);
      assert.deepEqual(reordered.requests.map(r => r.position), [0, 1, 2]);
      await work.saveMeeting(owner, pid, { notes: "순서 유지" }, meeting.id);
      assert.deepEqual((await work.listMeetings(owner, pid)).meetings.find(m => m.id === meeting.id).requests.map(r => r.requestId), order);
      const reversed = [...order].reverse();
      const response = await work.saveMeeting(owner, pid, { requests: reversed.map(requestId => ({ requestId })) }, meeting.id);
      assert.deepEqual(response.meeting.requests.map(r => r.requestId), reversed);

      await assert.rejects(work.deleteMeeting(outsider,pid,meeting.id));
      await assert.rejects(work.deleteMeeting(owner,pid2,meeting.id));
      await assert.rejects(work.deleteMeeting(owner,pid,legacy.id),e=>e.getStatus()===409);
      const approvalId=randomUUID();
      await pg.query("INSERT INTO task_approvals(id,project_id,source,meeting_id,title,requested_by,plans,status) VALUES($1,$2,'meeting',$3,'삭제 승인 테스트',$4,'[]','pending')",[approvalId,pid,meeting.id,owner.id]);
      await assert.rejects(work.deleteMeeting(owner,pid,meeting.id),e=>e.getStatus()===409);
      assert((await work.listMeetings(owner,pid)).meetings.some(m=>m.id===meeting.id));
      await pg.query("UPDATE task_approvals SET status='cancelled' WHERE id=$1",[approvalId]);
      await work.deleteMeeting(owner,pid,meeting.id);
      assert(!(await work.listMeetings(owner,pid)).meetings.some(m=>m.id===meeting.id));
      assert.equal((await pg.query("SELECT id FROM project_requests WHERE id=$1",[request.id])).rows.length,1);
      assert.equal((await pg.query("SELECT meeting_id FROM request_workflow_links WHERE request_id=$1",[request.id])).rows[0].meeting_id,null);
      assert.equal((await pg.query("SELECT * FROM meeting_requests WHERE meeting_id=$1",[meeting.id])).rows.length,0);
      assert.equal((await pg.query("SELECT meeting_id,status FROM task_approvals WHERE id=$1",[approvalId])).rows[0].status,'cancelled');
      assert.equal((await pg.query("SELECT meeting_id FROM task_approvals WHERE id=$1",[approvalId])).rows[0].meeting_id,null);
      await assert.rejects(work.deleteMeeting(owner,pid,meeting.id),e=>e.getStatus()===404);
      const relinked=(await work.saveMeeting(owner,pid,{title:"다시 연결",scheduledAt:"2026-10-30T02:00:00Z",requests:[{requestId:request.id}]})).meeting;
      assert.equal(relinked.requests[0].requestId,request.id);
    } finally {await pg.close();}
  },
);
