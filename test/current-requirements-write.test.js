import test from 'node:test';
import assert from 'node:assert/strict';
import {applyMemoryActions,parseMemoryActions,parseMemoryContent,loadCaptureCandidates} from '../lib/memory.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent} from './helpers.js';
const stamp=(day)=>`2026-10-${day}T04:00:00.000Z`;
const options=(day,op='op-'+day)=>({sessionId:'session-req',turn:day,messageId:'m-'+day,eventSeq:day,sourceEventTime:Date.parse(stamp(day)),now:()=>new Date(stamp(day)),operationId:op});
const action=(value,extra={})=>({action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute:'回复长度',value,evidence:value,requirementScope:'general',requirementLifetime:'ongoing',...extra});
function setup(){const store=memoryStore();return {store,ctx:{tools:store.tools,agent:fakeAgent('session-req'),project:'personal',config:{project:'personal',captureFolder:'chats'},now:()=>new Date(stamp(24))}};}
test('current requirement keeps its identity and one history link while old evidence stays in history',async()=>{
 const {store,ctx}=setup();const first=await applyMemoryActions(ctx,[action('平时随意一点，一次简短些')],options(24));const id=first.results[0].memoryId;
 await applyMemoryActions(ctx,[action('平时随意一点，回复长短自行决定',{action:'UPDATE',targetMemoryId:id})],options(25));
 let current=[...store.notes.values()].find(n=>n.frontmatter.status==='active');let historical=[...store.notes.values()].filter(n=>n.frontmatter.status==='history');
 assert.equal(current.frontmatter.memory_id,id);assert.equal(current.frontmatter.requirement_scope,'general');assert.equal(current.frontmatter.recorded_at,stamp(24));assert.equal(historical.length,1);
 assert.doesNotMatch(current.content,/一次简短些/);assert.match(historical[0].content,/一次简短些/);assert.equal(historical[0].frontmatter.supersedes_memory_id,id);
 assert.match(current.content,/历史证据: \[\[/);assert.equal(current.frontmatter.latest_history_permalink,historical[0].permalink);
 await applyMemoryActions(ctx,[action('平时随意一点，回复长短自行决定',{action:'UPDATE',targetMemoryId:id})],options(25));
 assert.equal(store.notes.size,2,'same operation cannot add history twice');
 await applyMemoryActions(ctx,[action('平时自然交流，长短自行决定',{action:'UPDATE',targetMemoryId:id})],options(26));
 current=store.notes.get(current.permalink);assert.equal((current.content.match(/历史证据:/g)||[]).length,1);assert.equal(store.notes.size,3);
 assert.ok([...store.notes.values()].some(n=>n.frontmatter.status==='history'&&n.content.includes('历史证据: [[')),'later snapshot retains path to older evidence');
});
test('temporary instruction does not change current requirement or create a failed retry',async()=>{
 const {store,ctx}=setup();const r=await applyMemoryActions(ctx,[action('长短自行决定')],options(24));const before=JSON.stringify([...store.notes]);
 const result=await applyMemoryActions(ctx,[action('这次只说一句话',{action:'UPDATE',targetMemoryId:r.results[0].memoryId,requirementLifetime:'temporary'})],options(25));
 assert.equal(result.committed,false);assert.equal(result.results[0].skipped,'temporary-requirement');assert.equal(JSON.stringify([...store.notes]),before);
});
test('different standing scopes coexist, explicit target cannot rewrite another scope',async()=>{
 const {store,ctx}=setup();const r=await applyMemoryActions(ctx,[action('长短自行决定')],options(24));
 await applyMemoryActions(ctx,[action('代码评审先给简短结论',{requirementScope:'work'})],options(25));assert.equal(store.notes.size,2);
 await assert.rejects(applyMemoryActions(ctx,[action('工作里只说一句',{action:'UPDATE',targetMemoryId:r.results[0].memoryId,requirementScope:'work'})],options(26)),/target-mismatch/);
 assert.ok([...store.notes.values()].some(n=>n.frontmatter.requirement_scope==='general'&&n.frontmatter.value==='长短自行决定'));
});
test('older delayed write cannot override newer standard; reads and history do not reinforce',async()=>{
 const {store,ctx}=setup();const r=await applyMemoryActions(ctx,[action('简短些')],options(24));const id=r.results[0].memoryId;
 await applyMemoryActions(ctx,[action('长短自行决定',{action:'UPDATE',targetMemoryId:id})],options(26));
 const result=await applyMemoryActions(ctx,[action('越短越好',{action:'UPDATE',targetMemoryId:id})],options(25));assert.equal(result.results[0].skipped,'superseded');
 const before=JSON.stringify([...store.notes]);await loadCaptureCandidates(ctx,'回复长度');assert.equal(JSON.stringify([...store.notes]),before);
});
test('capture protocol preserves requirement semantics and body parser round trips scope',()=>{
 const [a]=parseMemoryActions(JSON.stringify({actions:[{...action('长度自行决定'),requirement_scope:'chat',requirement_lifetime:'temporary'}]}));
 assert.equal(a.requirementScope,'chat');assert.equal(a.requirementLifetime,'temporary');
 const b=parseMemoryContent('<!-- dsh-fact-memory -->\n# 长度\n- [preference] 自行决定\n- 适用范围: general\n- 历史证据: [[旧长度]]\n');assert.equal(b.requirementScope,'general');assert.equal(b.historyTitle,'旧长度');
});
