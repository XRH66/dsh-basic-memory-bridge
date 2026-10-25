import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustedRelevance,
  isStrongCue,
  priorityFromMetadata,
  softenPriorityPatch,
} from '../lib/priority.js';

const NOW = new Date('2026-10-24T04:00:00.000Z');

test('softened priority halves at the default half-life and never goes below the floor', () => {
  const metadata = { base_priority: 0.5, softened_at: '2026-09-24T04:00:00.000Z' };
  const atThirtyDays = priorityFromMetadata(metadata, { now: NOW });
  assert.equal(atThirtyDays.softened, true);
  assert.equal(atThirtyDays.effectivePriority, 0.25);

  const faint = priorityFromMetadata({ base_priority: 0.02, softened_at: '2025-01-01T00:00:00.000Z' }, { now: NOW });
  assert.equal(faint.effectivePriority, 0.01);
});

test('softening multiplies the current effective priority instead of resetting it', () => {
  const patch = softenPriorityPatch(
    { base_priority: 0.4, softened_at: '2026-09-24T04:00:00.000Z', half_life_days: 30 },
    { factor: 0.5, now: NOW, reason: 'asked to bring it up less' },
  );
  assert.equal(patch.base_priority, 0.1);
  assert.equal(patch.softened_at, NOW.toISOString());
  assert.equal(patch.soften_count, 1);
  assert.equal(patch.soften_reason, 'asked to bring it up less');
});

test('a date cue only counts when it matches the target record date', () => {
  const note = '# 2026-10-19 - 交付竹桥\n\n- [event] 交付完成';
  assert.equal(isStrongCue('2026-10-18 的交付呢', note), false);
  assert.equal(isStrongCue('2026-10-19 的交付呢', note), true);
  assert.equal(isStrongCue('10月19日那次交付', note), true);
});

test('generic preference wording does not bypass a soft downweight', () => {
  const note = '# 饮品偏好 - 甜度\n\n- [preference] 不加糖';
  const metadata = { base_priority: 0.25, softened_at: '2026-09-24T04:00:00.000Z' };
  const generic = adjustedRelevance(1, metadata, { query: '我的偏好是什么', text: note, now: NOW });
  assert.equal(generic.strongCue, false);
  assert.equal(generic.score, 0.125);

  const specific = adjustedRelevance(1, metadata, { query: '饮品偏好 甜度', text: note, now: NOW });
  assert.equal(specific.strongCue, true);
  assert.equal(specific.score, 1);
});

test('two-character overlap with a generic word is not a strong cue', () => {
  const note = '# 沟通偏好 - 回答方式\n\n- [preference] 先给结论';
  assert.equal(isStrongCue('我的饮品偏好', note), false);
  assert.equal(isStrongCue('用户偏好记忆', note), false);
});
