import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { createRecoveryStore, observeLocalFacts } from '../lib/recovery.js';
import { applyMemoryActions } from '../lib/memory.js';
import { resolveConfig } from '../lib/config.js';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION, OTHER_SESSION } from './helpers.js';

const action = (value, attribute='饮茶偏好') => ({action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute,value,evidence:value,occurredAt:'日期未明'});
const reply = (...actions) => JSON.stringify({actions});
async function setup(t, llm, transform) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-recovery-'));
  const vaultPath = path.join(root,'vault'); await fs.mkdir(vaultPath);
  const memory = memoryStore();
  const tools = transform ? transform(memory.tools) : memory.tools;
  const config = resolveConfig({vaultPath,autoRecall:false,personalRecall:false,maxIndexNotes:0});
  const bridges=[];
  const make=(model=llm, findAgent) => { const b=createBridge({config,tools,llm:model,findAgent});bridges.push(b);return b; };
  t.after(async()=>{for(const b of bridges){await b.dispose();await b.getMemoryStatus(TARGET_SESSION);}assert.ok(root.startsWith(path.join(os.tmpdir(),'dafeiyu-recovery-')));await fs.rm(root,{recursive:true,force:true});});
  return {root,config,memory,tools,make,bridge:make()};
}
async function turn(bridge, n, text, time=Date.now(), id=TARGET_SESSION) {
  const agent=fakeAgent(id);
  bridge.onSessionEvent(agent.session,turnStart(n));
  bridge.onSessionEvent(agent.session,userMessage(text,{id:'message-'+n,time}));
  await runPreStep(bridge,{agent,turn:n,messages:[]});
  bridge.onSessionEvent(agent.session,assistantMessage(n,'嗯，知道了。'));
  bridge.onSessionEvent(agent.session,turnEnd(n));
  await bridge.waitForIdle(id);
  return agent;
}

test('timer retries a failed model call without another user turn; payload is removed on success',async(t)=>{
  t.mock.timers.enable({apis:['setInterval','Date']});
  const llm=fakeLlm([new Error('offline'),reply(action('晚上常喝温茶'))]);
  const {bridge,memory}=await setup(t,llm);
  await turn(bridge,1,'晚上常喝温茶');
  assert.equal((await bridge.getRecoveryState()).jobs.length,1);
  assert.equal((await bridge.getMemoryStatus(TARGET_SESSION)).jobs[0].state,'failed');
  t.mock.timers.tick(31_000);
  await bridge.waitForIdle();
  assert.equal((await bridge.getRecoveryState()).jobs.length,0);
  assert.equal(memory.notes.size,1);
  assert.equal(llm.calls.length,2);
  assert.equal((await bridge.getMemoryStatus(TARGET_SESSION)).jobs[0].state,'saved');
});

test('partial write survives worker restart and resumes only the unfinished action',async(t)=>{
  let fail=true;
  const llm=fakeLlm(reply(action('晚上常喝温茶'),action('周日去拍照','周末安排')));
  const fixture=await setup(t,llm,(base)=>({get(name,agent){const d=base.get(name,agent);return {...d,async execute(args,exec){
    if(name.endsWith('__write_note')&&args.content.includes('周日去拍照')&&fail)throw new Error('disk temporary failure');
    return d.execute(args,exec);
  }};}}));
  await turn(fixture.bridge,1,'晚上常喝温茶，周日去拍照');
  const pending=await fixture.bridge.getRecoveryState();
  assert.equal(Object.keys(pending.jobs[0].completed).length,1);
  fixture.bridge.dispose();fail=false;
  const model=fakeLlm(new Error('must not synthesize saved actions again'));
  const resumed=fixture.make(model,()=>fakeAgent(TARGET_SESSION));
  await resumed.retryPending({force:true});
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);
  assert.equal(fixture.memory.notes.size,2);
  assert.equal(model.calls.length,0);
});

test('write committed but response lost: replay uses the operation marker instead of duplicating',async(t)=>{
  let lose=true;
  const fixture=await setup(t,fakeLlm(reply(action('晚上常喝温茶'))),(base)=>({get(name,agent){const d=base.get(name,agent);return {...d,async execute(args,exec){
    const r=await d.execute(args,exec);
    if(name.endsWith('__write_note')&&lose){lose=false;throw new Error('connection lost after commit');}return r;
  }};}}));
  await turn(fixture.bridge,1,'晚上常喝温茶');
  assert.equal((await fixture.bridge.getRecoveryState()).jobs.length,1);
  fixture.bridge.dispose();
  const resumed=fixture.make(fakeLlm(new Error('no new extraction')),()=>fakeAgent(OTHER_SESSION));
  await resumed.retryPending({force:true});
  assert.equal(fixture.memory.notes.size,1);
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);
});

test('an old failed action cannot overwrite a newer statement, and correction replay creates only one history',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const ctx={config:f.config,project:'personal',tools:f.tools,agent:fakeAgent(TARGET_SESSION)};
  const first={sessionId:TARGET_SESSION,turn:1,messageId:'a',sourceEventTime:1000000,operationId:'first'};
  await applyMemoryActions(ctx,[action('喝温茶')],first);
  const next={...first,turn:3,messageId:'c',sourceEventTime:3000000,operationId:'newest'};
  await applyMemoryActions(ctx,[action('现在喝花茶')],next);
  const count=f.memory.notes.size;
  const old=await applyMemoryActions(ctx,[action('曾经喝咖啡')],{...first,turn:2,messageId:'b',sourceEventTime:2000000,operationId:'delayed'});
  assert.equal(old.results[0].skipped,'superseded');
  await applyMemoryActions(ctx,[action('现在喝花茶')],next);
  assert.equal(f.memory.notes.size,count);
  const current=[...f.memory.notes.values()].find(n=>n.frontmatter.memory_kind==='fact');
  assert.match(current.content,/现在喝花茶/);
  assert.doesNotMatch(current.content,/曾经喝咖啡/);
});

test('manual edits detected across restart queue a correction; first baseline and metadata-only edits do not',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const folder=path.join(f.config.vaultPath,'chats','facts');await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,'用户 - 饮茶偏好.md');
  const content='---\npermalink: personal/chats/facts/用户-饮茶偏好\nstatus: active\n---\n<!-- dsh-fact-memory -->\n# 用户 - 饮茶偏好\n- [preference] 喝温茶\n';
  await fs.writeFile(file,content);
  const store=createRecoveryStore(f.config);
  await observeLocalFacts(f.config,store);
  assert.equal((await store.read()).pending.length,0);
  await fs.writeFile(file,content.replace('喝温茶','喝花茶'));
  const restored=createRecoveryStore(f.config);
  await observeLocalFacts(f.config,restored);
  const state=await restored.read();
  assert.equal(state.pending.length,1);
  assert.equal(state.pending[0].expectedValue,'喝花茶');
  assert.ok(state.observed[state.pending[0].permalink].externalEditedAt>0);
  await restored.update(s=>{s.pending=[];});
  await fs.appendFile(file,'\n手写的一句无关备注');
  await observeLocalFacts(f.config,restored);
  assert.equal((await restored.read()).pending.length,0);
});

test('failed durable checkpoint does not update the cache; retry can persist it',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const store=createRecoveryStore(f.config);
  await store.add({id:'original'});
  const dir=path.join(f.root,'management','memory-status');
  const file=path.join(dir,'recovery.json');
  const saved=await fs.readFile(file,'utf8');await fs.rm(file);await fs.mkdir(file);
  await assert.rejects(store.add({id:'new'}));
  assert.deepEqual((await store.read()).jobs.map(j=>j.id),['original']);
  await fs.rmdir(file);await fs.writeFile(file,saved);
  await store.add({id:'new'});
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).jobs.length,2);
});

test('a new completed turn is durable while an older extraction is still blocked',async(t)=>{
  let entered,release;
  const started=new Promise(r=>{entered=r;}), gate=new Promise(r=>{release=r;});
  let first=true;
  const llm={async *stream(){if(first){first=false;entered();await gate;}yield {type:'text-delta',text:'{"actions":[]}'};}};
  const f=await setup(t,llm);
  const one=turn(f.bridge,1,'随便聊聊');
  await started;
  const two=turn(f.bridge,2,'今天歇一会儿',Date.now(),OTHER_SESSION);
  // Give accept's async filesystem commit time, without releasing the model call.
  let jobs=[];
  for(let i=0;i<20;i++){jobs=(await f.bridge.getRecoveryState()).jobs;if(jobs.length===2)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(jobs.length,2);
  const disk=JSON.parse(await fs.readFile(path.join(f.root,'management','memory-status','recovery.json'),'utf8'));
  assert.equal(disk.jobs.length,2);
  release();await Promise.all([one,two]);
});
