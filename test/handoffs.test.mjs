import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHandoffs, parsePlan, depsState, startPoint, handoffPolicy, MAX_HANDOFFS_PER_TASK, MAX_PLAN_STEPS } from '../lib/handoffs.mjs';

const roleIds = ['architect', 'frontend', 'backend', 'database', 'qa', 'devops'];
const fence = obj => '```json\n' + JSON.stringify(obj) + '\n```';

test('parseHandoffs reads the Handoff section', () => {
  const text = `## Summary\nDone.\n## Handoff\n${fence([{ role: 'qa', mode: 'change', title: 'Add tests for pagination', reason: 'new endpoint has no tests' }])}\n`;
  assert.deepEqual(parseHandoffs(text, { fromRole: 'backend', roleIds }), [
    { role: 'qa', mode: 'change', title: 'Add tests for pagination', details: '', reason: 'new endpoint has no tests', repo: '' },
  ]);
});

test('parseHandoffs ignores other sections, unknown roles, self-handoffs and duplicates', () => {
  const text = [
    '## Recommendations', fence([{ role: 'qa', title: 'Not a handoff' }]),
    '## Handoff', fence([
      { role: 'backend', title: 'Myself again' },
      { role: 'pm', title: 'Unknown role' },
      { role: 'qa', title: 'Test it' },
      { role: 'qa', title: 'test it' },
      { role: 'qa', title: '' },
    ]),
  ].join('\n');
  const out = parseHandoffs(text, { fromRole: 'backend', roleIds });
  assert.deepEqual(out.map(h => h.title), ['Test it']);
  assert.equal(out[0].mode, 'change');
});

test('parseHandoffs caps the number of handoffs and survives bad JSON', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ role: 'qa', title: `t${i}` }));
  assert.equal(parseHandoffs(`## Handoff\n${fence(many)}`, { fromRole: 'backend', roleIds }).length, MAX_HANDOFFS_PER_TASK);
  assert.deepEqual(parseHandoffs('## Handoff\n```json\n[{oops\n```', { fromRole: 'backend', roleIds }), []);
  assert.deepEqual(parseHandoffs('No handoff here', { fromRole: 'backend', roleIds }), []);
});

test('parsePlan keeps earlier dependencies only, so there are no cycles', () => {
  const text = `## Plan\n${fence([
    { key: 'api', role: 'backend', title: 'Add endpoint', dependsOn: ['tests'] },
    { key: 'db', role: 'database', title: 'Add index' },
    { key: 'tests', role: 'qa', mode: 'change', title: 'Test endpoint', dependsOn: ['api', 'db', 'nope'] },
    { key: 'x', role: 'pm', title: 'Unknown role' },
  ])}`;
  const steps = parsePlan(text, { roleIds });
  assert.deepEqual(steps.map(s => [s.key, s.dependsOn]), [['api', []], ['db', []], ['tests', ['api', 'db']]]);
});

test('parsePlan gives missing or duplicate keys unique ones and caps the steps', () => {
  const steps = parsePlan(`## Plan\n${fence([{ role: 'qa', title: 'a' }, { key: 'k', role: 'qa', title: 'b' }, { key: 'k', role: 'qa', title: 'c' }])}`, { roleIds });
  assert.deepEqual(steps.map(s => s.key), ['s1', 'k', 'k_']);
  const many = Array.from({ length: 12 }, (_, i) => ({ role: 'qa', title: `t${i}` }));
  assert.equal(parsePlan(`## Plan\n${fence(many)}`, { roleIds }).length, MAX_PLAN_STEPS);
});

test('depsState', () => {
  const tasks = { a: { id: 'a', title: 'A', status: 'done' }, b: { id: 'b', title: 'B', status: 'running' }, c: { id: 'c', title: 'C', status: 'failed' } };
  const byId = id => tasks[id];
  assert.equal(depsState({ dependsOn: [] }, byId).state, 'ready');
  assert.equal(depsState({ dependsOn: ['a'] }, byId).state, 'ready');
  assert.equal(depsState({ dependsOn: ['a', 'b'] }, byId).state, 'waiting');
  const blocked = depsState({ dependsOn: ['a', 'c'] }, byId);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.by, 'c');
  assert.equal(depsState({ dependsOn: ['gone'] }, byId).state, 'blocked');
});

test('startPoint builds on the previous branch or reads its worktree', () => {
  const prev = { repo: 'api', mode: 'change', branch: 'agent/backend/x', worktree: '/wt/1', cleaned: false };
  assert.deepEqual(startPoint(prev, 'change', 'api'), { base: 'agent/backend/x', readFrom: '' });
  assert.deepEqual(startPoint(prev, 'analyze', 'api'), { base: '', readFrom: '/wt/1' });
  assert.deepEqual(startPoint(prev, 'change', 'web'), { base: '', readFrom: '' });
  assert.deepEqual(startPoint({ ...prev, cleaned: true }, 'analyze', 'api'), { base: '', readFrom: '' });
  assert.deepEqual(startPoint(null, 'change', 'api'), { base: '', readFrom: '' });
});

test('handoffPolicy: project, then app, then ask', () => {
  assert.equal(handoffPolicy('auto', 'off'), 'off');
  assert.equal(handoffPolicy('auto', undefined), 'auto');
  assert.equal(handoffPolicy('bogus', ''), 'ask');
});
