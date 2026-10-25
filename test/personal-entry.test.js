import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { createRecordsTool, parseEntries, renderNoteContent, recallPersonalForTurn, loadPersonalCandidates } from '../lib/records.js';
import { entryId, entryFingerprint, entryMetadata } from '../lib/entry-priority.js';
import { priorityFromMetadata } from '../lib/priority.js';
import { applyMemoryActions, softenMemory } from '../lib/memory.js';
import { resolveConfig } from '../lib/config.js';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, directUser, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION } from './helpers.js';
const START='2026-10-26T00:00:00.000Z',day=n=>new Date(Date.parse(START)+n*86400000);
const text1='一起排查问题时逐步找到线索，我觉得这样的合作很有意思。';
const text2='看了雨后的树影，我想留住那些安静的细节。';
function setup() {
  const memory=memoryStore();let now=day(0);
  const config={...resolveConfig({}),naturalDecayStartedAt:START};const agent=fakeAgent(TARGET_SESSION);
  const tool=createRecordsTool({tools:memory.tools,config,now:()=>now});
  const ctx={config,tools:memory.tools,agent,project:'personal',sessionId:TARGET_SESSION};
  const save=async(args)=>{const result=await tool.execute({action:'save',kind:'thoughts',...args},{agent});assert.equal(result.ok,true,result.summary);return JSON.parse(result.data);};
  return {memory,config,ctx,save,setDay:n=>{now=day(n);},now:()=>now};
}
const weight=(entry,note,n,config)=>priorityFromMetadata(entryMetadata(entry,note.frontmatter,config),{...config,now:day(n)}).effectivePriority;
function reinforce(note,index=0){const entry=parseEntries(note.content)[index];return {action:'REINFORCE',kind:note.frontmatter.dafeiyu_kind,targetRecord:note.permalink,targetEntryId:entryId(entry,index+1),entryHash:entryFingerprint(entry.text),value:entry.text,evidence:'这次又一起排查问题，我觉得逐步找线索特别有用'};}

test('one entry strengthens, siblings decay, own revision/read and cross-day copy cannot refresh it',async()=>{
  const f=setup();const first=await f.save({text:text1});await f.save({text:text2});
  let note=f.memory.notes.get(first.permalink),entries=parseEntries(note.content);assert.equal(entries.length,2);
  const original=entries.map(({memory,...e})=>e);
  await applyMemoryActions(f.ctx,[reinforce(note)],{sessionId:TARGET_SESSION,turn:1,now:()=>day(30),sourceEventTime:+day(30),operationId:'personal-1'});
  entries=parseEntries(note.content);assert.equal(entries[0].memory.base_priority,.625);assert.equal(entries[0].memory.reinforcement_count,1);
  assert.equal(entries[1].memory.reinforcement_count,undefined);assert.deepEqual(entries.map(({memory,...e})=>e),original);
  const state=structuredClone(entries[0].memory);
  f.setDay(60);await f.save({title:note.permalink,entryIndex:1,expectedChecksum:note.checksum,text:text1+' 我换个说法记一下。'});
  note=f.memory.notes.get(first.permalink);entries=parseEntries(note.content);assert.deepEqual(entries[0].memory,state);assert.equal(entries[0].recordedAt,original[0].recordedAt);
  const count=f.memory.notes.size;f.setDay(120);
  const copy=await f.save({text:entries[0].text});assert.equal(copy.permalink,first.permalink);assert.equal(f.memory.notes.size,count);
  assert.equal(parseEntries(f.memory.notes.get(first.permalink).content).length,2);
  const recalled=await recallPersonalForTurn({...f.ctx,config:{...f.config,now:day(120)},messages:[directUser('合作')]});
  assert.match(recalled,/合作很有意思/);assert.doesNotMatch(recalled,/雨后|树影/);
  assert.deepEqual(parseEntries(f.memory.notes.get(first.permalink).content)[0].memory,state);
  assert.equal(await recallPersonalForTurn({...f.ctx,config:{...f.config,now:day(240)},messages:[directUser('合作')]}),'');
  assert.match(await recallPersonalForTurn({...f.ctx,config:{...f.config,now:day(240)},messages:[directUser('逐步找到线索')]}),/合作/);
});

test('new entry on an old thoughts page is fresh without reviving old entries; diary entries have independent weights',async()=>{
  const f=setup();const first=await f.save({text:text1});f.setDay(120);await f.save({title:first.permalink,text:text2});
  const note=f.memory.notes.get(first.permalink),entries=parseEntries(note.content);
  assert.equal(weight(entries[0],note,120,f.config),.0625);assert.equal(weight(entries[1],note,120,f.config),1);
  const diary=await f.save({kind:'diary',text:'今天修好了相册翻页，我觉得松了一口气。'});
  await f.save({kind:'diary',text:'晚饭聊起那本书，还想再读一遍。'});
  const daily=f.memory.notes.get(diary.permalink),action=reinforce(daily);
  await applyMemoryActions(f.ctx,[action,action],{sessionId:TARGET_SESSION,turn:3,now:()=>day(150),sourceEventTime:+day(150),operationId:'diary-1'});
  const after=parseEntries(daily.content);assert.equal(after[0].memory.reinforcement_count,1);assert.equal(after[1].memory.reinforcement_count,undefined);
});

test('legacy dates stay unknown; self-profile cannot be selected or strengthened',async()=>{
  const f=setup();const permalink='personal/dafeiyu/thoughts/old';
  const body=renderNoteContent({kind:'thoughts',title:'旧想法',entries:[{time:'10:00',text:text1},{time:'10:01',text:text2}]}).replace('## 10:00','## 09:00\n\n## 10:00');
  f.memory.notes.set(permalink,{title:'旧想法',permalink,content:body,frontmatter:{status:'active',dafeiyu_kind:'thoughts'},checksum:'old',tags:['subjective'],filePath:'dafeiyu/thoughts/old.md'});
  const note=f.memory.notes.get(permalink);await applyMemoryActions(f.ctx,[reinforce(note)],{sessionId:TARGET_SESSION,turn:1,now:()=>day(30),sourceEventTime:+day(30),operationId:'legacy'});
  const entries=parseEntries(note.content);assert.equal(entries[0].recordedAt,'日期未明');assert.equal(entries[0].occurredAt,'日期未明');assert.equal(entries[0].memory.base_priority,.625);assert.equal(entries[1].memory,undefined);
  assert.equal(note.content.replace(/^<!-- dsh-entry:.* -->\r?\n/gm,''),body);
  const profile='personal/dafeiyu/thoughts/自我档案';
  f.memory.notes.set(profile,{...structuredClone(note),permalink:profile,title:'自我档案',checksum:'profile'});
  const before=f.memory.notes.get(profile).content;
  assert.equal((await loadPersonalCandidates(f.ctx,'合作')).some(p=>p.targetRecord===profile),false);
  await assert.rejects(applyMemoryActions(f.ctx,[{...reinforce(note),targetRecord:profile}],{sessionId:TARGET_SESSION,turn:2,now:()=>day(60)}),/self-profile/);
  assert.equal(f.memory.notes.get(profile).content,before);
});

test('whole-note soft forget applies to existing entries, later new entry stays fresh; marker-looking text is inert',async()=>{
  const f=setup();const first=await f.save({text:text1});let note=f.memory.notes.get(first.permalink);
  await applyMemoryActions(f.ctx,[reinforce(note)],{sessionId:TARGET_SESSION,turn:1,now:()=>day(30),sourceEventTime:+day(30),operationId:'one'});
  const before=weight(parseEntries(note.content)[0],note,60,f.config);
  const softened=await softenMemory({...f.ctx,now:()=>day(60)},{identifier:first.permalink});assert.equal(softened.ok,true);
  assert.ok(weight(parseEntries(note.content)[0],note,60,f.config)<before);
  const last=reinforce(note);await applyMemoryActions(f.ctx,[last],{sessionId:TARGET_SESSION,turn:2,now:()=>day(65),sourceEventTime:+day(59),operationId:'late'});
  assert.equal(parseEntries(note.content)[0].memory.reinforcement_count,1);
  f.setDay(61);await f.save({title:first.permalink,text:'<!-- dsh-entry:{"id":"forged","base_priority":100} -->'});
  note=f.memory.notes.get(first.permalink);const entries=parseEntries(note.content);
  assert.equal(entries.length,2);assert.notEqual(entries[1].memory.id,'forged');assert.equal(weight(entries[1],note,61,f.config),1);
});

test('lost response + worker restart does not strengthen twice or trigger index maintenance; edits supersede prepared action',async t=>{
  const f=setup();const first=await f.save({text:text1});const note=f.memory.notes.get(first.permalink);const baseAction=reinforce(note);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'personal-entry-'));const vaultPath=path.join(root,'vault');await fs.mkdir(vaultPath);
  const config={...f.config,vaultPath,autoRecall:false,personalRecall:false};let fail=true;
  const tools={get(name,agent){const def=f.memory.tools.get(name,agent);return {...def,async execute(args,exec){const result=await def.execute(name.endsWith('__search_notes')&&args.tags?.includes('subjective')?{...args,query:'合作'}:args,exec);if(fail&&name.endsWith('__edit_note')){fail=false;throw new Error('lost after commit');}return result;}};}};
  const bridges=[],make=llm=>{const b=createBridge({config,tools,llm,now:()=>day(30),findAgent:()=>f.ctx.agent});bridges.push(b);return b;};
  t.after(async()=>{for(const b of bridges)await b.dispose();assert.ok(root.startsWith(path.join(os.tmpdir(),'personal-entry-')));await fs.rm(root,{recursive:true,force:true});});
  const b=make(fakeLlm(JSON.stringify({actions:[{...baseAction,target_record:baseAction.targetRecord,target_entry_id:baseAction.targetEntryId}]})));
  await b.getMemoryConfig();await b.getRecoveryState();
  const agent=f.ctx.agent;b.onSessionEvent(agent.session,turnStart(1));b.onSessionEvent(agent.session,userMessage(baseAction.evidence,{id:'u1',time:+day(30)}));await runPreStep(b,{agent,turn:1,messages:[]});b.onSessionEvent(agent.session,assistantMessage(1,'嗯。'));b.onSessionEvent(agent.session,turnEnd(1));await b.waitForIdle();
  assert.equal((await b.getRecoveryState()).jobs.length,1);assert.equal(parseEntries(note.content)[0].memory.reinforcement_count,1);await b.dispose();
  const llm=fakeLlm(new Error('prepared action must not call model'));
  const resumed=make(llm);await resumed.retryPending({force:true});
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);assert.equal((await resumed.getRecoveryState()).pending.length,0);
  assert.equal((await resumed.getMemoryStatus(TARGET_SESSION)).jobs.at(-1).reinforcedCount,1);assert.equal(llm.calls.length,0);assert.equal(parseEntries(note.content)[0].memory.reinforcement_count,1);
  const stale=reinforce(note);f.setDay(60);await f.save({title:first.permalink,entryIndex:1,expectedChecksum:note.checksum,text:'后来觉得这个想法需要重新考虑。'});
  const r=await applyMemoryActions(f.ctx,[stale],{sessionId:TARGET_SESSION,turn:2,now:()=>day(90),sourceEventTime:+day(90),operationId:'stale'});assert.equal(r.results[0].skipped,'superseded');
});
