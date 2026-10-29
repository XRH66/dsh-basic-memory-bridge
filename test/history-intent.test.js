import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsHistory } from '../lib/history-intent.js';

test('history intent requires a prior-state or change-trail request', () => {
  for (const query of [
    '以前要求多长，后来怎么改的？',
    '之前的回复长度要求是什么？',
    '上次我要求什么语气？',
    '回复长度要求后来怎么改的？',
    '列出回复要求的修改历史。',
    '现在帮我回顾一下以前的回复要求。',
    '比较以前和现在的回复风格。',
    '以前和现在的回复要求有什么不同？',
    'What tea did I prefer before?',
    'What was my previous response preference?',
    'How has my response length requirement changed?',
    'What did I previously require, and what do I want now?',
    'Show the revision history of my reply requirements.',
  ]) assert.equal(wantsHistory(query), true, query);
});

test('past mentions, current rules, negated history and quoted code do not request snapshots', () => {
  for (const query of [
    '', undefined, '之前', '上次',
    '之前说的回复长度现在按什么来？',
    '上次的回复风格，现在有什么要求？',
    '之前说的要求继续照做。',
    '之前说的回复长度按什么来？',
    '如何修改回复长度要求？',
    '我现在要求简短，之前说的详细不用了。',
    '不用查历史，只告诉我现在按什么来。',
    '不要回顾以前的要求。',
    '我喜欢历史。',
    'What is my current reply length, as discussed before?',
    'Follow my previous instructions.',
    'How should I change my reply requirements?',
    "Don't show the history, just use the current rule.",
    '```以前要求多长，后来怎么改的？```现在要求是什么？',
  ]) assert.equal(wantsHistory(query), false, String(query));
});
