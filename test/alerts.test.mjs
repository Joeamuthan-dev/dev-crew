import test from 'node:test';
import assert from 'node:assert/strict';
import { detectAlerts, ALERT_DEFAULTS } from '../public/alerts.js';

const ctx = { roleName: id => ({ backend: 'Backend Engineer', qa: 'QA / Test Engineer', architect: 'Solutions Architect', reviewer: 'Code Reviewer' }[id] || id), projectName: () => 'DataEz', hasReviewer: () => true };
const running = { id: 't1', status: 'running', role: 'backend', projectId: 'dataez', title: 'Add paging' };

test('only the end of a run raises alerts (reloads never replay them)', () => {
  const done = { ...running, status: 'done', mode: 'change', git: { commits: ['a'] } };
  assert.equal(detectAlerts(undefined, done, ctx).length, 0);
  assert.equal(detectAlerts({ ...done }, done, ctx).length, 0);
  assert.equal(detectAlerts({ ...running, status: 'queued' }, { ...running }, ctx).length, 0);
});

test('a branch ready for review offers Review and Ask the Code Reviewer', () => {
  const [a] = detectAlerts(running, { ...running, status: 'done', mode: 'change', git: { commits: ['a', 'b'], shortstat: '3 files changed' } }, ctx);
  assert.equal(a.event, 'review');
  assert.match(a.title, /Ready for review: Add paging/);
  assert.match(a.body, /Backend Engineer on DataEz · 2 commits · 3 files changed/);
  assert.deepEqual(a.actions.map(x => x.label), ['Review', 'Ask the Code Reviewer']);
  assert.equal(a.actions[1].url, '#/t/t1/review');
  const [b] = detectAlerts({ ...running, role: 'reviewer' }, { ...running, role: 'reviewer', status: 'done', mode: 'change', git: { commits: ['a'] } }, ctx);
  assert.equal(b.actions.length, 1); // a reviewer's own branch: no "ask the reviewer"
});

test('a plan and a handoff can be started straight from the alert', () => {
  const plan = { ...running, role: 'architect', status: 'done', mode: 'analyze', planTask: true, plan: { status: 'proposed', steps: [{}, {}, { missingRepo: true }] } };
  const [p] = detectAlerts({ ...plan, status: 'running' }, plan, ctx);
  assert.equal(p.event, 'plan');
  assert.match(p.body, /2 steps \(1 skipped\) from the Solutions Architect/);
  assert.deepEqual(p.actions[0], { id: 'plan', label: 'Start plan', kind: 'api', method: 'POST', path: '/api/tasks/t1/plan/start', doneText: 'Plan started', doneBody: '2 linked task(s) are queued.' });
  const ho = { ...running, status: 'done', mode: 'change', git: { commits: ['a'] }, handoffs: [{ id: 'h9', role: 'qa', title: 'Test paging', reason: 'new code', status: 'proposed' }] };
  const [h] = detectAlerts(running, ho, ctx);
  assert.equal(h.event, 'handoff');
  assert.equal(h.actions[0].path, '/api/tasks/t1/handoffs/h9/start');
  assert.match(h.body, /QA \/ Test Engineer: Test paging · new code/);
  // a plan step's handoffs are not offered (the plan already has the next steps)
  assert.equal(detectAlerts(running, { ...ho, origin: 'plan' }, ctx)[0].event, 'review');
});

test('failures, limits, empty runs and refused commands', () => {
  assert.equal(detectAlerts(running, { ...running, status: 'failed', error: 'boom' }, ctx)[0].title, 'Failed: Add paging');
  const st = detectAlerts(running, { ...running, status: 'stopped', stopReason: 'budget' }, ctx)[0];
  assert.match(st.title, /Stopped at the cost limit/);
  assert.equal(st.actions[0].label, 'Continue…');
  const empty = detectAlerts(running, { ...running, status: 'done', mode: 'change', noChanges: true, git: { commits: [] } }, ctx)[0];
  assert.equal(empty.event, 'failed');
  assert.match(empty.title, /^No changes/);
  const refused = detectAlerts({ ...running, refused: [] }, { ...running, status: 'done', mode: 'analyze', refused: [{ command: 'dotnet --list-sdks' }] }, ctx);
  assert.deepEqual(refused.map(a => a.event), ['done', 'refused']);
  assert.match(refused[1].body, /dotnet --list-sdks/);
  assert.equal(ALERT_DEFAULTS.events.done, false); // "any task finished" is opt-in
});
