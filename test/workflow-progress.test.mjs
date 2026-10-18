import test from 'node:test';
import assert from 'node:assert/strict';
import {customerWorkflowStage} from '../dist/workspace/workflow-progress.js';
test('customer development starts when planning task is created',()=>{
 assert.equal(customerWorkflowStage([{status:'todo',stageKey:'plan',completionMode:'document'}]),'in_progress');
 assert.equal(customerWorkflowStage([],true),'review');
});
test('customer completion requires every code task deployment',()=>{
 const plan={status:'done',stageKey:'plan',completionMode:'document'};
 assert.equal(customerWorkflowStage([plan,{status:'deploy_pending',stageKey:'api',completionMode:'code'}]),'in_progress');
 assert.equal(customerWorkflowStage([plan,{status:'released',stageKey:'api',completionMode:'code'}]),'completed');
 assert.equal(customerWorkflowStage([plan]),'completed');
 assert.equal(customerWorkflowStage([{status:'done'}]),'in_progress');
});
