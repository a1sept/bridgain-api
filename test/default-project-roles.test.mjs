import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProjectRoles } from '../dist/workspace/default-project-roles.js';
import { allProjectPermissions } from '../dist/workspace/project-roles.service.js';
import { WorkspaceService } from '../dist/workspace/workspace.service.js';
import { projects, projectMemberships, teamMemberships } from '../dist/db/schema/workspace.js';
import { projectRoles, projectMemberRoles } from '../dist/db/schema/project-roles.js';
const actor={id:'00000000-0000-4000-8000-000000000001',displayName:'owner',accountType:'team'};
const projectId='00000000-0000-4000-8000-000000000002';
const teamId='00000000-0000-4000-8000-000000000003';
test('starter roles contain useful bounded permissions and independent copies',()=>{
 const roles=defaultProjectRoles(allProjectPermissions);
 assert.deepEqual(roles.map(r=>r.name),['프로젝트 관리자','기획자','디자이너','개발자','QA']);
 assert.deepEqual(roles[0].permissions,allProjectPermissions);
 for(const role of roles.slice(1)){
  assert.ok(role.permissions.includes('tasks.read'));
  assert.ok(!role.permissions.some(p=>p.startsWith('approvals.')||['roles.manage','members.manage','project.settings'].includes(p)));
  assert.ok(role.permissions.every(p=>allProjectPermissions.includes(p)));
 }
 assert.ok(roles.find(r=>r.name==='기획자').permissions.includes('tasks.assign'));
 assert.equal(new Set(roles.map(r=>r.color)).size,5);
 roles[0].permissions.push('mutated');
 assert.ok(!defaultProjectRoles(allProjectPermissions)[0].permissions.includes('mutated'));
});
test('new project creates roles and creator assignment in the same transaction',async()=>{
 const writes=[];
 let transactions=0;
 const tx={
  select:()=>({from:table=>({where:()=>({
   for:async()=>[],
   then:resolve=>resolve(table===teamMemberships?[{teamId,permissionRole:'owner'}]:[]),
  })})}),
  insert:table=>({values:value=>{
   writes.push({table,value});
   return {returning:async()=>table===projects?[{id:projectId}]:table===projectRoles?value.map((role,i)=>({...role,id:`role-${i}`})):[]};
  }}),
 };
 const service=new WorkspaceService({db:{transaction:async fn=>{transactions++;return fn(tx);}}});
 const result=await service.create(actor,{name:'새 프로젝트',teamId});
 assert.equal(result.id,projectId);
 assert.equal(transactions,1);
 const membership=writes.find(w=>w.table===projectMemberships).value;
 assert.equal(membership.rolesConfigured,true);
 assert.equal(writes.find(w=>w.table===projectRoles).value.length,5);
 assert.deepEqual(writes.find(w=>w.table===projectMemberRoles).value,{projectId,userId:actor.id,roleId:'role-0'});
});
