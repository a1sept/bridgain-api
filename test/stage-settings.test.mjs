import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultStageSettings,parseStageSettings} from '../dist/workspace/stage-settings.service.js';
test('default stage settings preserve parallel development prerequisites',()=>{
 const settings=parseStageSettings(defaultStageSettings());const feature=settings.presets.find(p=>p.id==='feature');
 assert.deepEqual(feature.stages.find(s=>s.id==='qa').dependsOn,['frontend','backend']);
 assert.equal(settings.stageTypes.length,5);
});
test('settings reject cyclic templates, duplicate ids and unbounded lists',()=>{
 const base=defaultStageSettings();base.presets[0].stages[0].dependsOn=['deploy'];assert.throws(()=>parseStageSettings(base));
 const dup=defaultStageSettings();dup.stageTypes.push(dup.stageTypes[0]);assert.throws(()=>parseStageSettings(dup));
 assert.throws(()=>parseStageSettings({stageTypes:[],presets:[]}));
 const bad=defaultStageSettings();bad.presets[0].stages[0].completionMode='unknown';assert.throws(()=>parseStageSettings(bad));
});

test('settings reject null body',()=>assert.throws(()=>parseStageSettings(null)));
