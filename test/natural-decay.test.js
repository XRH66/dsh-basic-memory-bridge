import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { priorityFromMetadata, reinforcePriorityPatch, softenPriorityPatch, adjustedRelevance } from '../lib/priority.js';
import { createBridge } from '../lib/index.js';
import { applyMemoryActions, softenMemory } from '../lib/memory.js';
import { resolveConfig } from '../lib/config.js';
import { recallForTurn } from '../lib/recall.js';
import { updateIndexBody, AUTO_START, AUTO_END } from '../lib/index-pages.js';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, fakeTools, mcpResult, directUser, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION } from './helpers.js';

const START = '2026-10-25T00:00:00.000Z';
const day = n => new Date(Date.parse(START) + n * 86400000);
const opts = n => ({naturalDecayStartedAt:START, now:day(n)});
const value = '晚上看书常喝温的荞麦茶，不加糖';
const action = {action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute:'晚上饮茶',value,evidence:value,occurredAt:'日期未明'};

test('old notes start ageing at rollout; new notes use their later recording date, threshold allows empty recall',()=>{
  const old={recorded_at:'2020-01-01T00:00:00Z'};
  assert.equal(priorityFromMetadata(old,opts(0)).effectivePriority,1);
  assert.equal(priorityFromMetadata(old,opts(30)).effectivePriority,.5);
  assert.equal(priorityFromMetadata({recorded_at:day(30).toISOString()},opts(30)).effectivePriority,1);
  assert.equal(priorityFromMetadata(old,opts(1000)).effectivePriority,.01);
  assert.equal(adjustedRelevance(1,old,{...opts(120),query:'我的习惯是什么',text:value}).eligible,false);
  const cue=adjustedRelevance(1,old,{...opts(120),query:'那种荞麦茶还记得吗',text:value});
  assert.equal(cue.eligible,true);assert.equal(cue.strongCue,true);assert.equal(cue.score,1);
  assert.deepEqual(old,{recorded_at:'2020-01-01T00:00:00Z'});
});

test('reaffirmation partially restores current strength and extends half-life within cap, with a day cooldown',()=>{
  const p=reinforcePriorityPatch({},opts(30));
  assert.equal(p.base_priority,.625);assert.equal(p.half_life_days,37.5);assert.equal(p.reinforcement_count,1);
  assert.equal(reinforcePriorityPatch(p,opts(30)),null);
  assert.equal(reinforcePriorityPatch(p,opts(29)),null);
  assert.ok(priorityFromMetadata(p,opts(60)).effectivePriority > priorityFromMetadata({},opts(60)).effectivePriority);
  assert.equal(reinforcePriorityPatch({half_life_days:170},opts(30)).half_life_days,180);
  const softened=softenPriorityPatch(p,opts(60));
  assert.ok(softened.base_priority < .2);
  assert.equal(reinforcePriorityPatch(softened,opts(59)),null);
  assert.ok(reinforcePriorityPatch(softened,opts(90)).base_priority < 1);
});

test('index refresh preserves manual groups before and after the auto region',()=>{
  const note={title:'沟通偏好',permalink:'personal/chats/facts/style',content:'- [preference] 少用套话'};
  const manual='# 索引\n\n## 评价与回应\n- [[沟通偏好]] —— 旧内容\n\n## 其他\n保留这段\n';
  const updated=updateIndexBody(manual,{refresh:[note]});
  assert.match(updated,/## 评价与回应\n- \[\[沟通偏好\]\].*少用套话/);
  assert.ok(!updated.includes(AUTO_START));assert.ok(updated.endsWith('## 其他\n保留这段\n'));
  const withAuto='# 索引\n'+AUTO_START+'\n## 自动整理\n'+AUTO_END+'\n## 手工尾部\n- [[沟通偏好]] —— 旧内容\n';
  const after=updateIndexBody(withAuto,{refresh:[note]});
  assert.match(after,/## 手工尾部\n- \[\[沟通偏好\]\].*少用套话/);
  assert.equal((after.match(/少用套话/g)||[]).length,1);
});

test('metadata-only reinforcement retries after lost response without double counting or index maintenance',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'natural-decay-'));
  const config=resolveConfig({vaultPath:path.join(root,'vault'),autoRecall:false,personalRecall:false,maxIndexNotes:0});
  await fs.mkdir(config.vaultPath);
  const memory=memoryStore();let now=day(0), lose=false;
  const ctx={tools:memory.tools,agent:fakeAgent(TARGET_SESSION),config,project:'personal'};
  await applyMemoryActions(ctx,[action],{sessionId:TARGET_SESSION,turn:1,now:()=>now,sourceEventTime:+now});
  const note=[...memory.notes.values()][0], body=note.content;
  // The simulated old note exists before rollout, like a real upgrade.
  note.frontmatter.recorded_at=START;
  const reinforce={...action,action:'REINFORCE',target_memory_id:note.frontmatter.memory_id};
  const tools={get(name,agent){const d=memory.tools.get(name,agent);return {...d,async execute(args,exec){
    const r=await d.execute(args,exec);
    if(lose && name.endsWith('__edit_note') && args.metadata?.reinforced_at){lose=false;throw new Error('lost after commit');}return r;
  }};}};
  const bridges=[];
  const make=(llm)=>{const b=createBridge({config,tools,llm,now:()=>now,findAgent:()=>fakeAgent(TARGET_SESSION)});bridges.push(b);return b;};
  t.after(async()=>{for(const b of bridges)await b.dispose();assert.ok(root.startsWith(path.join(os.tmpdir(),'natural-decay-')));await fs.rm(root,{recursive:true,force:true});});
  const first=make(fakeLlm(JSON.stringify({actions:[reinforce]})));
  assert.equal((await first.getMemoryConfig()).naturalDecayStartedAt,START);
  now=day(30);lose=true;
  const send=async(b,n)=>{
    const agent=fakeAgent(TARGET_SESSION);
    b.onSessionEvent(agent.session,turnStart(n));b.onSessionEvent(agent.session,userMessage(value,{id:'u-'+n,time:+now}));
    await runPreStep(b,{agent,turn:n,messages:[]});
    b.onSessionEvent(agent.session,assistantMessage(n,'嗯。'));b.onSessionEvent(agent.session,turnEnd(n));await b.waitForIdle();
  };
  await send(first,2);
  assert.equal((await first.getRecoveryState()).jobs.length,1);
  assert.equal(note.frontmatter.reinforcement_count,1);
  await first.dispose();
  const model=fakeLlm(new Error('prepared actions must be reused'));
  const resumed=make(model);await resumed.retryPending({force:true});
  assert.equal((await resumed.getMemoryConfig()).naturalDecayStartedAt,START);
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);
  assert.equal((await resumed.getRecoveryState()).pending.length,0);
  assert.equal(note.frontmatter.reinforcement_count,1);assert.equal(note.frontmatter.base_priority,.625);
  assert.equal(note.content,body);assert.equal(note.frontmatter.recorded_at,START);
  assert.equal((await resumed.getMemoryStatus(TARGET_SESSION)).jobs.at(-1).reinforcedCount,1);
  assert.equal(model.calls.length,0);
  const third=make(fakeLlm(JSON.stringify({actions:[reinforce,reinforce]})));
  now=day(60);await send(third,3);
  assert.equal(note.frontmatter.reinforcement_count,2); // same-turn duplicate only strengthens once
  const soft=await softenMemory({...ctx,config:await third.getMemoryConfig(),now:()=>day(61)},{identifier:note.permalink});assert.equal(soft.ok,true);
  const before=note.frontmatter.base_priority;
  await applyMemoryActions({...ctx,config:await third.getMemoryConfig()},[{...reinforce,targetMemoryId:note.frontmatter.memory_id}],{sessionId:TARGET_SESSION,turn:4,now:()=>day(65),sourceEventTime:+day(60),operationId:'late'});
  assert.equal(note.frontmatter.base_priority,before);
  assert.equal(note.frontmatter.reinforcement_count,2);
  const conflict={...reinforce,targetMemoryId:note.frontmatter.memory_id,value:'换成冰咖啡'};
  await assert.rejects(applyMemoryActions({...ctx,config:await third.getMemoryConfig()},[conflict],{sessionId:TARGET_SESSION,turn:5,now:()=>day(90),sourceEventTime:+day(90)}),/changed fact/);
});

test('fact recall reads current weights when search metadata omits them, ranks all bounded candidates, excludes QA',async()=>{
  const notes=Array.from({length:4},(_,i)=>({title:'用户 - 习惯'+i,permalink:'personal/chats/facts/n'+i,score:1-i*.1,matched_chunk:'- [preference] '+value,metadata:{note_type:'note'}}));
  const fresh={recorded_at:START,base_priority:.625,decay_anchor_at:day(30).toISOString(),half_life_days:37.5,reinforcement_count:1};
  let qa=false;
  const tools=fakeTools(input=>input.name.endsWith('__search_notes')?mcpResult({results:notes}):mcpResult({title:notes[3].title,permalink:input.arguments.identifier,checksum:'c',content:'- [preference] '+value,
    frontmatter:{status:'active',memory_id:input.arguments.identifier,recorded_at:START,...(input.arguments.identifier.endsWith('3')?{...fresh,qa_fixture:qa}:{})}}));
  const ctx={config:{...resolveConfig({maxRecallNotes:3}),...opts(120)},tools,agent:fakeAgent(TARGET_SESSION),messages:[directUser('我有什么习惯')]};
  assert.match(await recallForTurn(ctx),/personal\/chats\/facts\/n3/);
  qa=true;assert.equal(await recallForTurn(ctx),'');
  assert.equal((await recallForTurn({...ctx,messages:[directUser('荞麦茶')],config:{...ctx.config,...opts(240)}})).includes('n3'),false);
});

test('duplicate ADD and factual correction reuse reinforcement; history keeps the old decay anchor',async()=>{
  const memory=memoryStore(),config={...resolveConfig({}),...opts(0)};
  const ctx={config,tools:memory.tools,agent:fakeAgent(TARGET_SESSION),project:'personal'};
  await applyMemoryActions(ctx,[action],{sessionId:TARGET_SESSION,turn:1,now:()=>day(0),sourceEventTime:+day(0)});
  const note=[...memory.notes.values()][0];
  const duplicate=await applyMemoryActions(ctx,[action],{sessionId:TARGET_SESSION,turn:2,now:()=>day(30),sourceEventTime:+day(30)});
  assert.equal(duplicate.results[0].metadataOnly,true);assert.equal(note.frontmatter.reinforcement_count,1);
  const currentBefore=priorityFromMetadata(note.frontmatter,opts(60)).effectivePriority;
  const update={...action,action:'CORRECT',targetMemoryId:note.frontmatter.memory_id,value:'其实是温的大麦茶，不加糖'};
  await applyMemoryActions(ctx,[update],{sessionId:TARGET_SESSION,turn:3,now:()=>day(60),sourceEventTime:+day(60)});
  assert.equal(note.frontmatter.reinforcement_count,2);
  assert.ok(priorityFromMetadata(note.frontmatter,opts(60)).effectivePriority>currentBefore);
  assert.equal(note.frontmatter.recorded_at,START);
  const history=[...memory.notes.values()].find(n=>n.frontmatter.memory_kind==='history');
  assert.equal(priorityFromMetadata(history.frontmatter,opts(60)).effectivePriority,currentBefore);
  assert.equal(history.frontmatter.status,'revoked');
});
