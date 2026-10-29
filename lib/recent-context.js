import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {managementDirectory} from './review.js';

export const RECENT_SOURCE = 'recent-conversation-context';
export const RECENT_TOOL = 'recent_conversation';
const hash = s => createHash('sha256').update(s).digest('hex');
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

/** Approximation only: not a provider bill or a model-specific tokenizer. */
export function estimateRecentTokens(text) {
  let units=0;
  for(const c of String(text)) units += /\p{Script=Han}/u.test(c)?0.6:c.codePointAt(0)<128?0.3:1;
  return Math.ceil(units);
}
function prefix(text, tokens) {
  let units=0, out='';
  for(const c of text){units+=/\p{Script=Han}/u.test(c)?0.6:c.codePointAt(0)<128?0.3:1;if(units>tokens)break;out+=c;}
  return out;
}
function clip(text, limit) {
  if(text.length<=limit)return text;
  const end=Math.max(0,limit-5);
  return text.slice(0,end).replace(/[\uD800-\uDBFF]$/,'')+'…[节选]';
}
function rowTokens(row){return estimateRecentTokens(JSON.stringify(row));}
export function recentContextFile(config){return config.vaultPath?path.join(managementDirectory(config),'recent-context',hash(String(config.project)).slice(0,20)+'.json'):'';}
function sourceLabel(row){return `${row.channel} · ${row.time} · 会话 ${row.sessionId} · 记录 ${row.id} · ${row.status==='completed'?'回复已结束':row.status==='pending'?'等待回复':'回复未完成'}`;}
function renderRow(row, maxChars=Infinity) {
  const header=sourceLabel(row)+'\n';
  const labels=row.messages.map(m=>(m.role==='user'?'用户':'助手')+'：');
  const texts=row.messages.map(m=>escape(m.text));
  const reference=messages=>{
    const seqs=messages.filter(m=>Number.isInteger(m.seq)&&m.seq>0).map(m=>m.seq);
    return seqs.length?'\n原文：用 session_event_read，session_id="'+row.sessionId+'"，逐条读取 seq='+seqs.join(',')+'。':'';
  };
  const full=header+texts.map((s,i)=>labels[i]+s).join('\n')+reference(row.messages.filter(m=>m.truncated));
  if(full.length<=maxChars)return full;
  const footer=reference(row.messages);
  const free=Math.max(0,maxChars-header.length-footer.length-labels.join('').length-Math.max(0,row.messages.length-1));
  if(free<row.messages.length*12)return clip(header+'本轮正文较长，暂不展开。'+footer,maxChars);
  // Water-fill shares: unused room from a short reply returns to the longer text.
  const lengths=texts.map(s=>s.length), grants=lengths.map(()=>0);let remaining=free;
  const order=lengths.map((length,i)=>({length,i})).sort((a,b)=>a.length-b.length);
  for(let n=0;n<order.length;n++){const {length,i}=order[n];grants[i]=Math.min(length,Math.floor(remaining/(order.length-n)));remaining-=grants[i];}
  return header+texts.map((s,i)=>labels[i]+clip(s,grants[i])).join('\n')+footer;
}

/** One local owner/project scope; no per-API partition and no time-based expiry. */
export function createRecentConversationStore({config,logger}={}) {
  const enabled=config.recentContext!==false && Boolean(config.vaultPath);
  const scope=String(config.project);
  const file=enabled?recentContextFile(config):'';
  const capacity=config.recentContextTokens||16384;
  let chain=Promise.resolve(), data={version:1,scope,rows:[],evictedTurns:0}, failure=null;
  function trim(){
    data.rows.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.id.localeCompare(b.id));
    let used=data.rows.reduce((n,r)=>n+rowTokens(r),0);
    while(used>capacity&&data.rows.length){used-=rowTokens(data.rows.shift());data.evictedTurns++;}
  }
  async function persist(){
    await fs.mkdir(path.dirname(file),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(tmp,JSON.stringify({...data,stats:summary()}),{flag:'wx'});await fs.rename(tmp,file);}
    finally{await fs.rm(tmp,{force:true});}
  }
  const ready=enabled?(async()=>{
    try{data=JSON.parse(await fs.readFile(file,'utf8'));if(data.version!==1||data.scope!==scope||!Array.isArray(data.rows))throw Error('invalid recent context store');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const before=data.rows.length;let interrupted=false;
    for(const row of data.rows)if(row.status==='pending'){row.status='interrupted';interrupted=true;}
    trim();if(data.rows.length!==before||interrupted)await persist();
  })():Promise.resolve();
  ready.catch(e=>{failure=e.message;logger?.warn?.('[basic-memory-bridge] recent context unavailable: '+e.message);});
  function serial(fn){const run=chain.then(()=>ready).then(fn);chain=run.catch(e=>{failure=e.message;logger?.warn?.('[basic-memory-bridge] recent context write/read failed: '+e.message);});return run;}
  function summary(){return {enabled,storage:enabled?(failure?'error':'ready'):'disabled',estimatedTokens:data.rows.reduce((n,r)=>n+rowTokens(r),0),capacityTokens:capacity,turns:data.rows.length,oldestAt:data.rows[0]?.time||null,newestAt:data.rows.at(-1)?.time||null,evictedTurns:data.evictedTurns,...failure?{error:failure}:{}};}
  function fitRow(row){
    // One oversized round must not evict the entire cache. Keep native event references.
    const maxRow=Math.floor(capacity/4), metadata=rowTokens({...row,messages:row.messages.map(m=>({...m,text:''}))});
    const perMessage=Math.max(32,Math.floor((maxRow-metadata)/Math.max(1,row.messages.length)));
    for(const m of row.messages)if(estimateRecentTokens(m.text)>perMessage){m.text=prefix(m.text,perMessage);m.truncated=true;}
  }
  const api={
    file,
    idle:async()=>{await ready.catch(()=>{});await chain;},
    stats:()=>serial(()=>structuredClone(summary())),
    record:input=>serial(async()=>{
      if(!enabled)return summary();
      if(!input.sessionId||!Number.isInteger(input.turn))throw Error('recent context requires source session and turn');
      if(input.channel&&input.channel!=='dsh')throw Error('external chat adapters are not connected');
      const id=hash(scope+'\0'+input.sessionId+'\0'+input.turn).slice(0,24);
      let row=data.rows.find(r=>r.id===id);
      // A finishing old turn must not resurrect a round already evicted.
      if(!row&&!input.user)return summary();
      if(!row){row={id,sessionId:input.sessionId,turn:input.turn,channel:'dsh',time:input.user.time,status:'pending',messages:[]};data.rows.push(row);}
      if(input.user){const m={...input.user,role:'user'};if(!m.id||!m.text||!Number.isFinite(Date.parse(m.time)))throw Error('recent context requires real message id, text and time');
        const old=row.messages.findIndex(x=>x.role==='user'&&x.id===m.id);if(old<0)row.messages.push(m);}
      if(input.status){
        row.messages=row.messages.filter(m=>m.role==='user');
        if(input.assistant?.text)row.messages.push({...input.assistant,role:'assistant'});
        row.status=input.status;
      }
      fitRow(row);trim();await persist();failure=null;return {...summary(),id};
    }),
    page:options=>serial(()=>{
      const {beforeId='',sessionId='',turn,excludeMessageIds=[],maxChars=2400}=options||{};
      if(!enabled)return {ok:false,reason:'disabled',text:'',items:[],...summary()};
      let end=data.rows.length;
      if(beforeId){end=data.rows.findIndex(r=>r.id===beforeId);if(end<0)return {ok:false,reason:'cursor-evicted',text:'该位置已滚动淘汰，请从最近一段重新读取。',items:[],...summary()};}
      const ids=new Set(excludeMessageIds);
      const head='<recent_conversation>\n近期聊天上下文，用于接续交流。说话人和时间按原消息保留；助手的建议不等于用户决定。\n';
      const tail='\n</recent_conversation>';
      const cursorLength='\n继续往前：recent_conversation(beforeId="'.length+24+'")'.length;
      let remaining=maxChars-head.length-tail.length-cursorLength, scanned=end;
      const selected=[];
      for(let i=end-1;i>=0;i--){
        const original=data.rows[i];scanned=i;
        if(original.sessionId===sessionId&&original.turn===turn)continue;
        const row={...original,messages:original.messages.filter(m=>!ids.has(m.id))};
        if(!row.messages.length)continue;
        const full=renderRow(row);
        if(full.length+2>remaining&&selected.length){scanned=i+1;break;}
        // Keep room for identity, dates and roles; don't create a useless fragment.
        if(remaining<80){scanned=i+1;break;}
        const line=renderRow(row,remaining-2);
        if(line.length+2>remaining){scanned=i+1;break;}
        selected.unshift({row,line,truncated:line!==full||row.messages.some(m=>m.truncated)});remaining-=line.length+2;
      }
      const items=selected.map(({row,truncated})=>({id:row.id,sessionId:row.sessionId,time:row.time,status:row.status,truncated}));
      const before=items[0]?.id||(scanned>0?data.rows[scanned-1]?.id:null), olderAvailable=scanned>0;
      const cursor=olderAvailable&&before?'\n继续往前：recent_conversation(beforeId="'+before+'")':'';
      let text=selected.length?head+selected.map(s=>s.line).join('\n\n')+(olderAvailable?cursor:'')+tail:'';
      if(text.length>maxChars)throw Error('recent context packing exceeded budget');
      return {ok:true,reason:items.length?'recent-sequence':olderAvailable?'budget-too-small':'no-unseen-turns',text,items,olderAvailable,beforeId:before,...summary()};
    }),
  };
  return api;
}

export function createRecentConversationTool({store,available,config,onRead}){
  return {
    name:RECENT_TOOL,
    description:'读取共享的近期聊天上下文。默认取最近一段；需要往前接续时用返回的 beforeId 继续。无额外模型调用，不写长期记忆。原文节选的来源可用 session_event_read 读取；已淘汰内容不会伪装成仍然存在。',
    parameters:{beforeId:{type:'string',description:'上一段返回的 beforeId；省略则从最新开始。'}},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:value.text||({'no-unseen-turns':'没有更早的可用近期对话。','budget-too-small':'当前预算不足以展开此轮，请按返回的beforeId继续往前读取。',disabled:'近期聊天上下文已关闭。'}[value.reason]||value.reason)}]},
    async execute(args,exec){
      if(!available(exec?.agent))return {ok:false,reason:'memory-unavailable',text:'当前回合未启用个人记忆，或处于纯净模式。'};
      const page=await store.page({beforeId:args?.beforeId||'',maxChars:config.maxContextChars});
      await onRead?.(exec?.agent,page);return page;
    },
  };
}
