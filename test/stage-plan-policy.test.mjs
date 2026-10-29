import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseStagePlans} from '../dist/workspace/stage-plan-policy.js';
const person='00000000-0000-4000-8000-000000000001';
const stage=(id,dependsOn=[])=>({id,name:id,title:`${id} 작업`,brief:'작업 내용',completionMode:'document',assigneeIds:[person],reviewerIds:[person],dependsOn});
test('stage plan permits parallel branches, stable dependencies and explicit self review',()=>{
 const out=parseStagePlans([stage('plan'),stage('design',['plan']),stage('api',['plan']),stage('qa',['design','api'])]);
 assert.deepEqual(out[3].dependsOn,['design','api']);assert.equal(out[0].reviewerIds[0],out[0].assigneeIds[0]);
});
test('stage plan rejects cycles, dangling refs, duplicates and missing required participants',()=>{
 for(const invalid of [[stage('a',['b']),stage('b',['a'])],[stage('a',['a'])],[stage('a',['unknown'])],[stage('a'),stage('a')],[{...stage('a'),assigneeIds:[]}],[{...stage('a'),reviewerIds:[]}]]) assert.throws(()=>parseStagePlans(invalid));
});
test('old approval payload remains compatible, empty staged payload is rejected',()=>{
 assert.equal(parseStagePlans(undefined),undefined);assert.throws(()=>parseStagePlans([]));
});

test('meeting drafts can retain incomplete stages, approval submission remains strict',()=>{
 const draft=[{id:'draft',name:'기획',title:'',brief:'',completionMode:'document',assigneeIds:[],reviewerIds:[],dependsOn:[]}];
 assert.deepEqual(parseStagePlans(draft,true),draft);
 assert.throws(()=>parseStagePlans(draft));
 assert.deepEqual(parseStagePlans([],true),[]);
});

test('stage deadlines accept valid dates, clearing and legacy omission but reject invalid dates', () => {
  for (const value of ['2028-02-29', '2026-10-30', null, '']) {
    assert.equal(parseStagePlans([{...stage('a'), dueDate:value}])[0].dueDate, value || null);
  }
  assert.equal(parseStagePlans([stage('a')])[0].dueDate, undefined);
  for (const value of ['2026-02-29', '2026-04-31', 'tomorrow', '2026-10-30T00:00:00Z', 123]) {
    assert.throws(() => parseStagePlans([{...stage('a'), dueDate:value}], true));
  }
});
