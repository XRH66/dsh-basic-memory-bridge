import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';

test('config defaults apply the product limits without a session allowlist', () => {
  const config = resolveConfig({});
  assert.equal(config.project, 'personal');
  assert.equal(config.autoRecall, true);
  assert.equal(config.autoCapture, true);
  assert.equal(config.maxRecallNotes, 3);
  assert.equal(config.maxRecallChars, 1200);
  assert.equal(config.recallTimeoutMs, 1500);
  assert.equal(config.captureTimeoutMs, 20000);
  assert.equal(config.captureMaxTokens, 1024);
  assert.equal(config.captureFolder, 'chats');
  assert.equal(config.minRecallScore, 0);
});

test('config clamps values above the hard limits', () => {
  const config = resolveConfig({
    maxRecallChars: 99999,
    recallTimeoutMs: 99999,
    captureTimeoutMs: 99999,
    maxRecallNotes: 99,
    minRecallScore: 9,
  });
  assert.equal(config.maxRecallChars, DEFAULT_CONFIG.maxRecallChars);
  assert.equal(config.recallTimeoutMs, DEFAULT_CONFIG.recallTimeoutMs);
  assert.equal(config.captureTimeoutMs, DEFAULT_CONFIG.captureTimeoutMs);
  assert.equal(config.maxRecallNotes, 10);
  assert.equal(config.minRecallScore, 1);
});

test('schemastery schema accepts an empty config and applies defaults', () => {
  const value = Config({});
  assert.equal(value.maxRecallChars, 1200);
  assert.equal(value.captureTimeoutMs, 20000);
  assert.equal(value.captureMaxTokens, 1024);
  assert.equal(value.minRecallScore, 0);
});
