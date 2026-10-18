import test from 'node:test';
import assert from 'node:assert/strict';
import { roleDefinition, effectivePermissions, allProjectPermissions } from '../dist/workspace/project-roles.service.js';
const base={isDeveloper:true,isOwner:false,rolesConfigured:false,rolePermissions:[],isAdmin:false,canApproveTasks:false,canApproveMerge:false};
test('explicit role configuration replaces legacy administrative privileges',()=>{
 const permissions=effectivePermissions({...base,isAdmin:true,rolesConfigured:true,rolePermissions:['documents.read','documents.create']});
 assert.deepEqual(permissions,['documents.read','documents.create']);
 assert.equal(permissions.includes('roles.manage'),false);
});
test('explicit empty role assignment denies permissions',()=>assert.deepEqual(effectivePermissions({...base,rolesConfigured:true}),[]));
test('owner remains protected even with no assigned role',()=>assert.deepEqual(effectivePermissions({...base,isOwner:true,rolesConfigured:true}),allProjectPermissions));
test('legacy delegated approval and baseline survive migration',()=>{
 const permissions=effectivePermissions({...base,canApproveTasks:true});
 assert.ok(permissions.includes('meetings.create'));
 assert.ok(permissions.includes('approvals.tasks'));
 assert.equal(permissions.includes('roles.manage'),false);
});
test('client can never acquire developer privileges through role data',()=>assert.deepEqual(effectivePermissions({...base,isDeveloper:false,isOwner:true,rolePermissions:allProjectPermissions}),[]));

test('legacy admin does not acquire merge approval without delegated flag',()=>{
 assert.equal(effectivePermissions({...base,isAdmin:true}).includes('approvals.merge'),false);
 assert.equal(effectivePermissions({...base,isAdmin:true,canApproveMerge:true}).includes('approvals.merge'),true);
});

test('approval roles include visibility needed for their approval action',()=>{
 const permissions=effectivePermissions({...base,rolesConfigured:true,rolePermissions:['approvals.tasks','approvals.merge']});
 assert.ok(permissions.includes('requests.read'));
 assert.ok(permissions.includes('tasks.read'));
 assert.equal(permissions.includes('tasks.assign'),false);
});

test('role colors normalize and old create clients receive default color',()=>{
 const body={name:'개발',permissions:[]};
 assert.equal(roleDefinition({...body,color:'#aAbBcC'}).color,'#AABBCC');
 assert.equal(roleDefinition(body).color,'#2D63ED');
});
test('role updates without color preserve persisted color by omitting update field',()=>{
 assert.equal(Object.hasOwn(roleDefinition({name:'개발',permissions:[]},true),'color'),false);
});
test('invalid role colors rejected before database write',()=>{
 for(const color of ['red','#FFF','#1234567','123456',null,123,'#GG0000']) assert.throws(()=>roleDefinition({name:'개발',permissions:[],color}));
});

test('new work approval and deployment permissions are never implicitly granted to legacy members',()=>{
 for(const extra of [{},{isAdmin:true},{canApproveMerge:true},{canApproveTasks:true}]) {
  const permissions=effectivePermissions({...base,...extra});
  assert.equal(permissions.includes('approvals.work'),false);
  assert.equal(permissions.includes('deploy.run'),false);
 }
 const assigned=effectivePermissions({...base,rolesConfigured:true,rolePermissions:['approvals.work','deploy.run']});
 assert.ok(assigned.includes('tasks.read'));
 assert.ok(assigned.includes('approvals.work'));
 assert.ok(assigned.includes('deploy.run'));
});
