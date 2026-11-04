import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { studySlide } from '../dist/workspace/study-slide.js';
test('legacy title and body keep content and layout; transforms survive Yjs round-trip', () => {
 const d = new Y.Doc(), page = 'page';
 d.getText(`title:${page}`).insert(0, '기존 제목'); d.getText(`body:${page}`).insert(0, '기존 본문');
 const before = studySlide(d, page);
 assert.equal(before.title, '기존 제목'); assert.equal(before.titleStyle.x, 6); assert.equal(before.titleStyle.fontSize, 38.4); assert.equal(before.titleStyle.bold, true);
 const style = d.getMap(`element:title:${page}`);
 for(const [k,v] of Object.entries({x:12,y:30,w:70,h:20,rotation:35,fontFamily:'serif',fontSize:48,color:'#cc3355',bold:false})) style.set(k,v);
 const copy = new Y.Doc(); Y.applyUpdate(copy, Y.encodeStateAsUpdate(d));
 const after = studySlide(copy, page);
 assert.equal(after.title, before.title); assert.equal(after.body, before.body);
 assert.equal(after.titleStyle.rotation, 35); assert.equal(after.titleStyle.fontFamily, 'serif'); assert.equal(after.titleStyle.color, '#cc3355'); assert.equal(after.titleStyle.bold, false);
 style.set('rotation', Infinity); assert.throws(() => studySlide(d,page));
 d.destroy(); copy.destroy();
});
