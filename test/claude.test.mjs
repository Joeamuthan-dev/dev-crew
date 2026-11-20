import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnv, runStats } from '../lib/claude.mjs';

test('leaves a normal environment alone', () => {
  const env = agentEnv({ PATH: 'x', ANTHROPIC_BASE_URL: 'https://proxy.example' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://proxy.example');
  assert.equal(env.PATH, 'x');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'dev-crew');
});

test('strips a parent Claude session but keeps account choices', () => {
  const env = agentEnv({
    PATH: 'x',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_OAUTH_SCOPES: 'y',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
    ANTHROPIC_API_KEY: 'sk-test',
    CLAUDE_CONFIG_DIR: 'C:/cfg',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'PATH']);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'dev-crew');
});

test('treats a foreign entrypoint as a parent session', () => {
  const env = agentEnv({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ANTHROPIC_BASE_URL: 'http://x' });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
});

test('inherit passes everything through', () => {
  const env = agentEnv({ CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'http://x' }, { inherit: true });
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://x');
});

test('runStats reads duration, tokens and models from a result event', () => {
  const s = runStats({
    duration_ms: 1200, duration_api_ms: 900,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    modelUsage: { 'claude-sonnet-x': {} },
  }, 1000, 3000);
  assert.deepEqual(s, {
    wallMs: 2000, durationMs: 1200, apiMs: 900,
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    models: ['claude-sonnet-x'],
  });
});

test('runStats lists the model that did the work first', () => {
  const s = runStats({ modelUsage: { 'claude-haiku-x': { costUSD: 0.002 }, 'claude-sonnet-x': { costUSD: 0.08 } } }, 0, 1);
  assert.deepEqual(s.models, ['claude-sonnet-x', 'claude-haiku-x']);
});

test('runStats copes with a missing result', () => {
  const s = runStats(null, 1000, 1500);
  assert.equal(s.wallMs, 500);
  assert.deepEqual(s.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});
