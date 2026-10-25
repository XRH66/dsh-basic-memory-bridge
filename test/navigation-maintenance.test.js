import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, directUser, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION } from './helpers.js';
import { resolveConfig } from '../lib/config.js';
import { recallNavigation } from '../lib/navigation.js';
import { maintainIndexes } from '../lib/maintenance.js';
import { createBridge } from '../lib/index.js';
import { readMemoryStatus } from '@local/dsh-global-settings/memory-status';

const factId='personal/chats/facts/用户-归纳偏好';
const indexId='personal/index/表达偏好';
const profileId='personal/dafeiyu/thoughts/自我档案';
const oldText='不要归纳读者。可以自然表达，文字清楚。';
const newText='不必每句话都归纳读者，按话题自然回应。可以自然表达，文字清楚。';
function seed(store) {
  const add = (permalink,title,content,frontmatter={},tags=[]) => store.notes.set(permalink,{
    permalink,title,content,frontmatter, tags, checksum:'initial-'+permalink, directory:permalink.replace(/^personal\//,'').split('/').slice(0,-1).join('/'),
    filePath:permalink.replace(/^personal\//,'')+'.md',
  });
  add(factId,'用户 - 归纳偏好','<!-- dsh-fact-memory -->\n# 用户 - 归纳偏好\n\n- [preference] 不要每句话都归纳我\n- subject: 用户\n- attribute: 归纳偏好\n',
    {memory_id:'fact-1',status:'active',subject:'用户',attribute:'归纳偏好',value:'不要每句话都归纳我',memory_kind:'fact',recorded_at:'2026-10-24T10:00:00Z'},['dsh-memory']);
  add(indexId,'表达偏好','# 表达偏好\n\n## 不要归纳\n- [[用户 - 归纳偏好]] —— 永远不许归纳\n\n保留我的手写段落。',{},['index','moc']);
  add(profileId,'自我档案','<!-- dafeiyu-record kind=thoughts -->\n# 自我档案\n\n## 10:00\n- 发生日期: 日期未明\n- 记录日期: 2026-10-24 10:00\n'+oldText+'\n\n## 11:00\n- 发生日期: 日期未明\n- 记录日期: 2026-10-24 11:00\n我喜欢虚构植物标本。\n',
    {dafeiyu:'true',dafeiyu_kind:'thoughts',status:'active',recorded_at:'2026-10-24T02:00:00Z'});
}
const plan = JSON.stringify({
  assignments:[],
  headings:[{index:indexId,find:'## 不要归纳',replace:'## 归纳与回应'}],
  profile:[{entryIndex:1,find:oldText,text:newText}],
});

test('navigation independently reads latest facts; ignores obsolete prose, missing-id index is usable', async () => {
  const store=memoryStore(); seed(store);
  const config=resolveConfig({personalRecall:false,maxRecallNotes:3,maxIndexChars:600});
  const agent=fakeAgent(TARGET_SESSION);
  const text=await recallNavigation({config,tools:store.tools,agent,messages:[directUser('归纳偏好')]});
  assert.match(text,/不要每句话都归纳我/);
  assert.doesNotMatch(text,/永远不许归纳|手写段落/);
  assert.ok(text.length<=600);
  assert.match(text,/personal\/index\/表达偏好/);
  const b=createBridge({config,tools:store.tools,llm:fakeLlm('{"actions":[]}')});
  const r=await runPreStep(b,{messages:[directUser('归纳偏好')],agent});
  assert.equal(r.messages.filter(m=>m.source.kind==='basic-memory-navigation').length,1);
  assert.equal(r.messages.filter(m=>m.source.kind==='basic-memory-recall').length,1);
});

test('unrelated, inactive, QA and softened references cannot revive through navigation', async () => {
  const store=memoryStore();seed(store);
  const ctx={config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),messages:[directUser('归纳偏好')]};
  store.notes.get(indexId).frontmatter.status='archived';
  assert.equal(await recallNavigation(ctx),'');
  delete store.notes.get(indexId).frontmatter.status;
  store.notes.get(factId).frontmatter.status='revoked';
  assert.equal(await recallNavigation(ctx),'');
  store.notes.get(factId).frontmatter.status='active';
  store.notes.get(factId).frontmatter.qa_fixture=true;
  assert.equal(await recallNavigation(ctx),'');
  delete store.notes.get(factId).frontmatter.qa_fixture;
  assert.equal(await recallNavigation({...ctx,messages:[directUser('今天晚饭吃饺子')]}),'');
  Object.assign(store.notes.get(factId).frontmatter,{base_priority:0.1,softened_at:'2026-01-01'});
  // A broad topic can select the index, but is not a distinctive cue for its fact.
  assert.equal(await recallNavigation({...ctx,messages:[directUser('表达')]}),'');
});

test('a navigation page does not consume any of the three direct fact slots', async () => {
  const store=memoryStore();seed(store);
  const first=store.notes.get(factId);
  for(const name of ['长度','语气'])store.notes.set(factId+'-'+name,{
    ...structuredClone(first),permalink:factId+'-'+name,title:'用户 - 归纳偏好'+name,
    content:first.content+'\n- [preference] '+name+'另一个现有偏好',
    frontmatter:{...first.frontmatter,memory_id:'fact-'+name},
  });
  const bridge=createBridge({config:{personalRecall:false,maxRecallNotes:3,maxIndexNotes:1},tools:store.tools,llm:fakeLlm('{"actions":[]}')});
  const result=await runPreStep(bridge,{agent:fakeAgent(TARGET_SESSION),messages:[directUser('归纳偏好')]});
  const facts=result.messages.find(m=>m.source.kind==='basic-memory-recall').content[0].text;
  const index=result.messages.find(m=>m.source.kind==='basic-memory-navigation').content[0].text;
  assert.match(facts,/长度另一个现有偏好/);assert.match(facts,/语气另一个现有偏好/);assert.match(facts,/不要每句话都归纳我/);
  assert.ok(facts.length<=1200);assert.ok(index.length<=600);
});

test('correction synchronizes linked rows and one self-profile entry through existing writer', async () => {
  const store=memoryStore();seed(store);
  const ctx={config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  const result=await maintainIndexes(ctx,[{action:'CORRECT',permalink:factId,memoryId:'fact-1'}]);
  assert.equal(result.updated,1);assert.equal(result.profileUpdated,1);
  assert.match(store.notes.get(indexId).content,/不要每句话都归纳我/);
  assert.match(store.notes.get(indexId).content,/保留我的手写段落/);
  assert.doesNotMatch(store.notes.get(indexId).content,/永远不许归纳|## 不要归纳/);
  assert.match(store.notes.get(profileId).content,/我喜欢虚构植物标本/);
  assert.match(store.notes.get(profileId).content,/可以自然表达，文字清楚/);
  assert.match(store.notes.get(profileId).content,/记录日期: 2026-10-24 10:00/);
  assert.equal(store.notes.get(factId).frontmatter.memory_id,'fact-1');
});

test('a concurrent index edit is preserved and reported for retry', async () => {
  const store=memoryStore();seed(store);
  const llm={async *stream(){
    store.notes.get(indexId).content+='\n用户刚补的内容';
    store.notes.get(indexId).checksum='concurrent-change';
    yield {type:'text-delta',text:plan};
  }};
  await assert.rejects(maintainIndexes({config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm},[{action:'CORRECT',permalink:factId}]),/WRITE_CONFLICT/);
  assert.match(store.notes.get(indexId).content,/用户刚补的内容/);
  assert.match(store.notes.get(profileId).content,/不要归纳读者/);
});

test('profile read failure and invalid ownership stay failures instead of reporting successful sync', async () => {
  const store=memoryStore();seed(store);
  const base=store.tools;
  let offline=true;
  const tools={get(name,agent){const d=base.get(name,agent);return {...d,execute:async(args,exec)=>{
    if(name.endsWith('__read_note') && args.identifier===profileId && offline) throw new Error('connection unavailable');
    return d.execute(args,exec);
  }};}};
  const ctx={config:resolveConfig({}),tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm:fakeLlm(plan)};
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/MEMORY_TOOL_FAILED/);
  assert.match(store.notes.get(indexId).content,/永远不许归纳/);
  offline=false;store.notes.get(profileId).content='# not a managed profile';
  await assert.rejects(maintainIndexes(ctx,[{action:'CORRECT',permalink:factId}]),/INVALID_SELF_PROFILE/);
});

test('a source changed while planning cannot apply an obsolete correction', async () => {
  const store=memoryStore();seed(store);
  const llm={async *stream(){store.notes.get(factId).checksum='new-source';yield {type:'text-delta',text:plan};}};
  await assert.rejects(maintainIndexes({config:resolveConfig({}),tools:store.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION,llm},[{action:'CORRECT',permalink:factId}]),/SOURCE_CHANGED/);
  assert.match(store.notes.get(indexId).content,/永远不许归纳/);
  assert.match(store.notes.get(profileId).content,/不要归纳读者/);
});

test('real hooks persist capture/no-action status, keep failed sync pending, and retry next completed turn', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-index-test-'));
  const vault=path.join(root,'vault'); await fs.mkdir(vault);
  const store=memoryStore();seed(store);
  const correction=JSON.stringify({actions:[{action:'CORRECT',kind:'fact',subject:'用户',attribute:'归纳偏好',value:'不用每句都归纳我',target_memory_id:'fact-1',evidence:'不用每句都归纳我'}]});
  const llm=fakeLlm([correction,'bad json','{"actions":[]}',plan]);
  const bridge=createBridge({config:{vaultPath:vault,personalRecall:false,maxIndexNotes:0},tools:store.tools,llm});
  const agent=fakeAgent(TARGET_SESSION);
  async function turn(n,text){
    bridge.onSessionEvent(agent.session,turnStart(n));
    bridge.onSessionEvent(agent.session,userMessage(text));
    await runPreStep(bridge,{turn:n,agent,messages:[directUser(text)]});
    bridge.onSessionEvent(agent.session,assistantMessage(n,'知道了'));
    bridge.onSessionEvent(agent.session,turnEnd(n));
    await bridge.waitForIdle(TARGET_SESSION);
  }
  try{
    await turn(1,'刚才说错了，不用每句都归纳我');
    let state=await bridge.getMemoryStatus(TARGET_SESSION);
    assert.equal(state.jobs.at(-1).state,'saved');
    assert.equal(state.jobs.at(-1).maintenance,'failed');
    assert.equal(state.pending.length,1);
    await turn(2,'嗯嗯');
    state=await bridge.getMemoryStatus(TARGET_SESSION);
    assert.equal(state.jobs.at(-1).state,'no-durable-actions');
    assert.equal(state.jobs.at(-1).maintenance,'saved');
    assert.equal(state.pending.length,0);
    const api=await readMemoryStatus(path.join(path.dirname(vault),'management','memory-status'),TARGET_SESSION);
    assert.equal(api.pendingCount,0);
    assert.equal(api.jobs.length,2);
    assert.doesNotMatch(JSON.stringify(api),/不用每句|profileRevisions|source_session/);
  }finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'dafeiyu-index-test-'));
    await fs.rm(root,{recursive:true,force:true});
  }
});

