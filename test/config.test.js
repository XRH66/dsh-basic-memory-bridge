import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Config, DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';

test('config defaults apply the product limits without a session allowlist', () => {
  const config = resolveConfig({});
  assert.equal(config.project, 'personal');
  assert.equal(config.autoRecall, true);
  assert.equal(config.autoCapture, true);
  assert.equal(config.maxRecallNotes, 3);
  assert.equal(config.maxRecallChars, 1200);
  assert.equal(config.recallTimeoutMs, 1500);
  assert.equal(config.captureTimeoutMs, 90000);
  assert.equal(config.captureMaxTokens, 8192);
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
  assert.equal(value.captureTimeoutMs, 90000);
  assert.equal(value.captureMaxTokens, 8192);
  assert.equal(value.minRecallScore, 0);
});


test('public bundle parameters preserve current schema and runtime defaults', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const marker = '      config:';
  assert.equal(patch.split(marker).length, 2, 'one public bundle config');
  const config = {};
  // The release template deliberately contains only flat, unquoted scalars.
  // Reject unsupported syntax instead of silently ignoring an override.
  for (const line of patch.split(marker)[1].split(/\r?\n/).filter(line => line.trim())) {
    const match = /^ {8}(\w+): (true|false|\d+|[a-z][a-z0-9_-]*)$/.exec(line);
    assert.ok(match, 'unexpected bundle config syntax: ' + line);
    const [, key, scalar] = match;
    assert.ok(Object.hasOwn(DEFAULT_CONFIG, key), 'unknown bundle parameter: ' + key);
    assert.ok(!Object.hasOwn(config, key), 'duplicate bundle parameter: ' + key);
    config[key] = scalar === 'true' ? true : scalar === 'false' ? false : /^\d+$/.test(scalar) ? Number(scalar) : scalar;
    assert.equal(config[key], DEFAULT_CONFIG[key], key + ' overrides the current default');
  }
  assert.deepEqual(Config(config), Config({}));
  assert.deepEqual(resolveConfig(config), resolveConfig({}));
  assert.equal(resolveConfig(Config(config)).captureTimeoutMs, 90000);
});
