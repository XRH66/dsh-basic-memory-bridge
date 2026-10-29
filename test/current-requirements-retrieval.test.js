import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFactRecall, parseSearchNotes, renderRecall, selectRecallNotes } from '../lib/recall.js';
import { composeMemoryContext, requirementValue } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { TARGET_SESSION, directUser, fakeAgent, fakeTools, mcpError, mcpResult, syntheticMessage } from './helpers.js';

const config = { ...resolveConfig({}), maxContextChars: 4000 };
const agent = fakeAgent(TARGET_SESSION);
const value = '回复应简洁，最多三句话。';

test('linked history survives composition when old wording lacks current query keywords', () => {
  const facts=[
    {title:'回复风格',permalink:'personal/chats/facts/current',memoryId:'current',kind:'fact',status:'active',value:'长短自己决定',requirementScope:'general',score:0.7},
    {title:'历史 - 用户',permalink:'personal/chats/history/old',memoryId:'old',kind:'history',status:'history',snippet:'每次简短些',supersedesMemoryId:'current',score:0.1},
  ];
  const messages=[directUser('回复多长，后来怎么改的？')];
  const result=composeMemoryContext({facts,messages,config,profilePresent:true});
  assert.match(result.text,/历史记录.*每次简短些/);
  assert.match(result.text,/长短自己决定/);
  const ordinary=composeMemoryContext({facts,messages:[directUser('现在回复长度按什么来？')],config,profilePresent:true});
  assert.doesNotMatch(ordinary.text,/每次简短些/);
});

function stored(id, { kind = 'fact', status = 'active', scope = 'chat', text = value, score = 0.8, ...extra } = {}) {
  const meta = { memory_id: id, memory_kind: kind, status, value: text, ...extra };
  if (scope !== undefined) meta.requirement_scope = scope;
  return {
    title: '回复风格与长度', permalink: `personal/chats/${kind === 'history' ? 'history' : 'facts'}/${id}`,
    score, frontmatter: meta,
    content: `<!-- dsh-fact-memory -->\n# 回复风格与长度\n- [${kind === 'history' ? 'history' : 'fact'}] ${text}\n- 历史证据: [[不要注入的旧版标题]]\n`,
  };
}

// Only the fake search enforces filters and then top K: a post-search filter
// cannot make the low-ranked current record appear in the crowding regression.
function retrieval(rows, { read, searchMetadata = false, search } = {}) {
  const tools = fakeTools(input => {
    if (input.name.endsWith('__search_notes')) {
      if (search) return search(input, rows);
      const args = input.arguments;
      const statuses = args.status ? [args.status] : args.metadata_filters?.status?.$in;
      const matches = rows.filter(n => !statuses || statuses.includes(n.frontmatter.status))
        .sort((a, b) => b.score - a.score).slice(0, args.page_size);
      return mcpResult({ results: matches.map(n => ({
        title: n.title, permalink: n.permalink, score: n.score,
        ...(searchMetadata ? { metadata: n.frontmatter } : {}),
      })) });
    }
    assert.ok(input.name.endsWith('__read_note'), 'retrieval may only search/read');
    const row = rows.find(n => n.permalink === input.arguments.identifier);
    assert.ok(row, 'read targets a returned search candidate');
    return read ? read(row) : mcpResult(row);
  });
  return {
    tools,
    collect: (messages, options = {}) => collectFactRecall({ tools, messages, agent, sessionId: TARGET_SESSION,
      config, logger: { warn() {} }, ...options }),
  };
}

function compose(facts, messages, options = {}) {
  return composeMemoryContext({ facts, messages, config, profilePresent: true, ...options });
}

test('ordinary current requirement survives history crowding, hydration-only scope and self-profile', async () => {
  const current = stored('length-current', { latest_history_permalink: 'personal/chats/history/h0', score: 0.6 });
  const snapshots = Array.from({ length: 20 }, (_, i) => stored('h' + i, {
    kind: 'history', status: i % 2 ? 'revoked' : 'history', score: 1,
    supersedes_memory_id: 'length-current', text: '旧要求：回复至少十二句话。',
  }));
  const f = retrieval([...snapshots, current]);
  const messages = [directUser('以前要求多长，后来怎么改的？'),
    directUser('之前说的回复长度现在按什么来？'), syntheticMessage('上次是什么？')];
  const notes = await f.collect(messages);
  assert.deepEqual(notes.map(n => n.memoryId), ['length-current']);
  assert.equal(notes[0].requirementScope, 'chat');
  assert.equal(notes[0].kind, 'fact');
  assert.equal(notes[0].status, 'active');
  assert.equal(f.tools.calls.length, 2);
  assert.equal(f.tools.calls[0].arguments.status, 'active');
  assert.equal(f.tools.calls[0].arguments.page_size, 5);
  const packed = compose(notes, messages);
  assert.equal(packed.selected, 1);
  assert.match(packed.text, /当前用户要求（适用范围:chat）/);
  assert.match(packed.text, /最多三句话/);
  const standalone = renderRecall(notes, config);
  assert.match(standalone, /Current user requirement/);
  assert.match(standalone, /requirement_scope=chat/);
  for (const text of [packed.text, standalone]) assert.doesNotMatch(text, /旧版标题|历史证据|latest_history_permalink|十二句话/);
});

test('explicit history keeps current plus history/revoked own ids even with identical values', async () => {
  const currentId = 'b3e5f492-7f81-4a10-a567-123456789abc';
  const current = stored('current');
  current.frontmatter.memory_id = currentId;
  const old = stored('old', { kind: 'history', status: 'history', supersedes_memory_id: currentId, score: 1 });
  const revoked = stored('revoked', { kind: 'history', status: 'revoked', supersedes_memory_id: currentId, score: 0.9 });
  const archived = stored('archived', { kind: 'history', status: 'archived', score: 1.2 });
  const f = retrieval([archived, old, revoked, current]);
  const messages = [directUser('另一个话题：旅行'), directUser('回复风格以前要求多长，后来怎么改的？')];
  const notes = await f.collect(messages);
  assert.deepEqual(notes.map(n => n.memoryId), [currentId, 'old', 'revoked']);
  assert.deepEqual(notes.slice(1).map(n => n.supersedesMemoryId), [currentId, currentId]);
  assert.equal(f.tools.calls.filter(c => c.name.endsWith('__read_note')).length, 3);
  const searches = f.tools.calls.filter(c => c.name.endsWith('__search_notes'));
  assert.equal(searches.length, 2);
  assert.equal(searches[0].arguments.status, 'active');
  assert.deepEqual(searches[1].arguments.metadata_filters, { status: { $in: ['history', 'revoked'] } });
  assert.doesNotMatch(searches[1].arguments.query, /旅行/);
  const navigation = [{ ...notes[0], permalink: 'personal/chats/facts/current-alias', value }];
  const packed = compose(notes, messages, { navigation });
  assert.equal(packed.selected, 3);
  assert.equal(packed.channels.navigation.dropped[0].reason, 'duplicate');
  const lines = packed.text.split('\n').filter(line => line.startsWith('- '));
  assert.match(lines[0], /当前用户要求/);
  assert.match(lines[1], /历史记录（非当前要求或事实）/);
  assert.match(lines[2], /已撤销的历史记录（非当前要求或事实）/);
  assert.equal((packed.text.match(/适用范围:chat/g) || []).length, 3);
  assert.doesNotMatch(packed.text, /memory_id|supersedesMemoryId|supersedes_memory_id/);
  assert.ok(!packed.text.includes(currentId));
  for (const note of notes) assert.ok(packed.text.includes(note.permalink));
  const historicalText = renderRecall(notes.slice(1), { ...config, maxRecallChars: 3000 });
  assert.match(historicalText, /Revoked history \(not current\)/);
  assert.doesNotMatch(historicalText, /supersedes_memory_id|supersedesMemoryId/);
  assert.ok(!historicalText.includes(currentId));
});

test('history receives a slot within the existing total K, never evicts all current facts', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => stored('current' + i, { score: 0.9 - i / 100 }));
  rows.push(stored('old', { kind: 'history', status: 'history', supersedes_memory_id: 'current2', score: 1 }));
  for (const maxRecallNotes of [1, 3]) {
    const f = retrieval(rows);
    const notes = await f.collect([directUser('回复要求以前是什么？')], { config: { ...config, maxRecallNotes } });
    assert.equal(notes.length, maxRecallNotes);
    assert.equal(notes[0].kind, 'fact');
    assert.equal(notes.filter(n => n.kind === 'history').length, maxRecallNotes === 1 ? 0 : 1);
    if (maxRecallNotes > 1) assert.equal(notes[0].memoryId, 'current2', 'retain the current requirement referenced by history');
    assert.ok(f.tools.calls.filter(c => c.name.endsWith('__read_note')).length <= 10);
  }
});

test('legacy untagged histories remain historical; ordinary untagged profile behavior stays intact', async () => {
  const old = stored('legacy', { kind: 'history', status: 'history' });
  delete old.frontmatter.requirement_scope;
  delete old.frontmatter.memory_kind;
  const f = retrieval([old]);
  const messages = [directUser('以前的回复风格是什么？')];
  const notes = await f.collect(messages);
  assert.equal(notes.length, 1, 'history still searches when no current match exists');
  assert.equal(notes[0].kind, 'history');
  assert.equal(notes[0].requirementScope, '');
  assert.match(compose(notes, messages).text, /历史记录（非当前要求或事实）/);
  assert.equal(compose(notes, [messages[0], directUser('现在回复风格是什么？')]).text, '');
  const untagged = { title: '回复风格', permalink: 'personal/chats/facts/style', memoryId: 'style',
    snippet: '回复带一点幽默。', baseScore: 0.8 };
  assert.equal(compose([untagged], [directUser('现在回复风格是什么？')]).channels.facts.dropped[0].reason, 'current-self-profile');
  assert.match(compose([{ ...untagged, title: '茶饮偏好', snippet: '平时喜欢花茶。' }], [directUser('喜欢什么茶？')]).text, /事实：平时喜欢花茶/);
});

test('scope and managed value can arrive only in read metadata; missing value uses observation body only', async () => {
  for (const scope of ['general', 'work', 'project:demo']) {
    const current = stored('scoped', { scope });
    delete current.frontmatter.value;
    const f = retrieval([current], { read: row => mcpResult({ ...row, frontmatter: undefined, metadata: JSON.stringify(row.frontmatter) }) });
    const messages = [directUser('回复长度现在按什么来？')];
    const notes = await f.collect(messages);
    assert.equal(notes[0].requirementScope, scope);
    assert.equal(notes[0].value, value);
    assert.match(compose(notes, messages).text, /当前用户要求/);
    assert.doesNotMatch(compose(notes, messages).text, /旧版标题|历史证据/);
  }
});

test('manual current body overrides stale frontmatter through hydration and both renderers', async () => {
  const stale = '旧元数据要求：回复至少十二句话。';
  const live = '手动修改后回复最多两句话。';
  const current = stored('manual-edit', { text: stale });
  current.content = `---\nvalue: |\n  - [fact] ${stale}\n---\n<!-- dsh-fact-memory -->\n# 回复风格\n- [fact] ${live}\n- 历史证据: [[旧版标题]]\n后来保留的历史说明。\n- [history] 旧版要求十句话。\n## 历史\n- [fact] 更早要求二十句话。\n`;
  const messages = [directUser('回复风格现在按什么来？')];
  const notes = await retrieval([current]).collect(messages);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].value, live);
  assert.equal(notes[0].priorityMetadata.value, stale, 'read does not rewrite stored metadata');
  for (const text of [compose(notes, messages).text, renderRecall(notes, config)]) {
    assert.ok(text.includes(live));
    assert.doesNotMatch(text, /旧元数据|十二句话|历史证据|旧版标题|历史说明|十句话|二十句话/);
  }
  // A navigation/scalar result must also retain its live value at composition.
  assert.ok(compose([{ ...notes[0], value: live, snippet: stale }], messages).text.includes(live));
  assert.ok(renderRecall([{ ...notes[0], value: live, snippet: stale }], config).includes(live));
});

test('metadata is used only when body is missing, never instead of a present managed/scalar body', async () => {
  const meta = { value: '元数据回退值。' };
  assert.equal(requirementValue('正文标量值。', meta), '正文标量值。');
  assert.equal(requirementValue('# 当前要求\n- [fact] 当前正文。\n- [history] 以前正文。\n- [fact] 后附历史。', meta), '当前正文。');
  for (const body of [undefined, '', ' \r\n ', '---\nvalue: old\n---\n']) assert.equal(requirementValue(body, meta), meta.value);
  for (const body of ['# 当前要求\n仅有手写说明。', '# 当前要求\n- 历史证据: [[旧版]]\n- [fact] 旧要求。', '- [history] 旧要求。']) {
    assert.equal(requirementValue(body, meta), '', 'existing body must not revive stale metadata or historical prose');
  }
  const row = stored('metadata-only');
  const notes = await retrieval([row], { read: note => mcpResult({ ...note, content: undefined }) })
    .collect([directUser('回复风格现在按什么来？')]);
  assert.equal(notes[0].value, value);
});

test('authoritative hydration prevents a stale search hit from presenting history as current', async () => {
  const current = stored('stale');
  const f = retrieval([current], { read: row => mcpResult({ ...row, frontmatter: {
    ...row.frontmatter, memory_kind: 'history', status: 'revoked', supersedes_memory_id: 'other',
  } }) });
  assert.deepEqual(await f.collect([directUser('现在回复长度是什么？')]), []);
});

test('composition accepts an already bounded requirement excerpt without metadata.value', () => {
  const note = { title: '回复风格', permalink: 'personal/chats/facts/excerpt', snippet: value,
    priorityMetadata: { memory_id: 'excerpt', memory_kind: 'fact', status: 'active', requirement_scope: 'chat' } };
  const packed = compose([note], [directUser('回复风格现在按什么来？')]);
  assert.equal(packed.selected, 1);
  assert.match(packed.text, /当前用户要求（适用范围:chat）/);
  assert.match(packed.text, /最多三句话/);
});

test('search and composition dedup by stable identity, not shared bodies or supersedes pointers', () => {
  const a = stored('shared', { scope: 'chat' });
  const alias = { ...a, permalink: 'personal/chats/facts/alias', score: 0.7 };
  const b = stored('other-scope', { scope: 'work' });
  const h = stored('history-own', { kind: 'history', status: 'history', supersedes_memory_id: 'shared' });
  const parsed = parseSearchNotes(mcpResult({ results: [a, alias, b, h] }), '以前的回复要求是什么？');
  const selected = selectRecallNotes(parsed, { maxRecallNotes: 5 });
  assert.deepEqual(selected.map(n => n.memoryId), ['shared', 'other-scope', 'history-own']);
  const packed = compose(selected, [directUser('以前的回复要求是什么？')]);
  assert.equal(packed.selected, 3);
  assert.match(packed.text, /适用范围:chat/);
  assert.match(packed.text, /适用范围:work/);
});

test('failed history search preserves current evidence and the shared budget', async () => {
  const row = stored('current');
  const diagnostics = {};
  const f = retrieval([row], { search: input => input.arguments.status === 'active'
    ? mcpResult({ results: [row] }) : mcpError('history unavailable') });
  const notes = await f.collect([directUser('以前要求多长，后来怎么改的？')], { diagnostics });
  assert.deepEqual(notes.map(n => n.memoryId), ['current']);
  assert.equal(diagnostics.history.reason, 'tool-error');
  assert.ok(compose(notes, [directUser('现在回复长度是什么？')], { config: { ...config, maxContextChars: 400 } }).text.length <= 400);
});
