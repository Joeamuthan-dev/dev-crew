import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanWorkflow, fixupPrompt, needsFixup, shouldAutoReview, pickBase } from '../lib/workflow.mjs';
import { detectAlerts } from '../public/alerts.js';
import { settingsFromForm } from '../lib/settings.mjs';

const wf = cleanWorkflow({});
const done = { mode: 'change', status: 'done', role: 'backend', branch: 'agent/backend/x', worktree: '/w', git: { commits: ['a1 one', 'b2 two'] }, checks: [{ label: 'Build', ok: true }] };
const ctx = { reviewerRole: 'reviewer', kindOf: id => (id === 'reviewer' ? 'review' : ''), builtOn: false, reviewing: false };

test('workflow settings: auto review on and one fix-up round by default, capped at 3', () => {
  assert.deepEqual(wf, { autoReview: true, fixRounds: 1 });
  assert.deepEqual(cleanWorkflow({ autoReview: false, fixRounds: 9 }), { autoReview: false, fixRounds: 3 });
  assert.equal(cleanWorkflow({ fixRounds: -1 }).fixRounds, 1);
  const { settings } = settingsFromForm({ workflow: { autoReview: false, fixRounds: '0' } }, {});
  assert.deepEqual(settings.workflow, { autoReview: false, fixRounds: 0 });
});

test('failed checks send the branch back with the exact errors, up to the rounds allowed', () => {
  const failing = { ...done, checks: [{ label: 'Tests', cmd: 'dotnet test', ok: false, code: 1, tail: 'Assert.Equal() Failure' }] };
  assert.equal(needsFixup(failing, wf), true);
  assert.equal(needsFixup({ ...failing, fixups: 1 }, wf), false);
  assert.equal(needsFixup(failing, { ...wf, fixRounds: 0 }), false);
  assert.equal(needsFixup({ ...failing, checks: [{ ok: false, preexisting: true }] }, wf), false); // not this change's fault
  assert.equal(needsFixup({ ...failing, cleaned: true }, wf), false);
  const p = fixupPrompt(failing.checks, 1, 1);
  assert.match(p, /### Tests \(`dotnet test`\) failed with exit code 1/);
  assert.match(p, /Assert\.Equal\(\) Failure/);
  assert.match(p, /fix-up round 1 of 1/);
  assert.match(p, /never skip, delete or weaken tests/);
});

test('a good branch goes to the reviewer once; not reviews, not failing ones, not ones a later step builds on', () => {
  assert.equal(shouldAutoReview(done, wf, ctx).ok, true);
  assert.equal(shouldAutoReview(done, { ...wf, autoReview: false }, ctx).ok, false);
  assert.equal(shouldAutoReview(done, wf, { ...ctx, reviewerRole: '' }).ok, false);
  assert.equal(shouldAutoReview({ ...done, role: 'reviewer' }, wf, ctx).ok, false);
  assert.equal(shouldAutoReview({ ...done, noChanges: true }, wf, ctx).ok, false);
  assert.equal(shouldAutoReview({ ...done, checks: [{ ok: false, label: 'Build' }] }, wf, ctx).why, 'checks failed');
  assert.equal(shouldAutoReview({ ...done, checks: [{ ok: false, preexisting: true }] }, wf, ctx).ok, true);
  assert.equal(shouldAutoReview(done, wf, { ...ctx, builtOn: true }).ok, false);
  assert.equal(shouldAutoReview(done, wf, { ...ctx, reviewing: true }).ok, false);
  assert.equal(shouldAutoReview({ ...done, reviewedCommits: 2 }, wf, ctx).ok, false);
  assert.equal(shouldAutoReview({ ...done, reviewedCommits: 1 }, wf, ctx).ok, true); // new commits since
});

test('new work starts from the default branch, never just the checked-out feature branch', () => {
  assert.equal(pickBase({ projectBase: 'develop', originHead: 'origin/main', local: ['main'], current: 'feature/x' }).base, 'develop');
  assert.equal(pickBase({ originHead: 'origin/main', local: ['feature/x', 'main'], current: 'feature/x' }).base, 'main');
  assert.equal(pickBase({ originHead: 'origin/trunk', local: ['feature/x'], current: 'feature/x' }).base, 'origin/trunk');
  assert.equal(pickBase({ local: ['feature/x', 'master'], current: 'feature/x' }).base, 'master');
  const last = pickBase({ local: ['feature/x'], current: 'feature/x' });
  assert.equal(last.base, 'feature/x');
  assert.match(last.why, /no main or master/);
});

test('alerts: a finished review is the alert, and its branch does not alert twice', () => {
  const names = { roleName: id => ({ reviewer: 'Code Reviewer', backend: 'Backend Engineer' }[id] || id), projectName: () => 'DataEz', hasReviewer: () => true };
  const running = { id: 'r1', status: 'running', role: 'reviewer', projectId: 'p', title: 'Review: Add paging', prevId: 't1' };
  const [a] = detectAlerts(running, { ...running, status: 'done', mode: 'analyze', review: { branch: 'b', result: { verdict: 'request_changes', summary: 'Null check missing', findings: [{ severity: 'major' }, { severity: 'nit' }] } } }, names);
  assert.equal(a.event, 'review');
  assert.equal(a.title, 'Changes requested: Add paging');
  assert.match(a.body, /2 findings \(1 serious\)/);
  assert.deepEqual(a.actions.map(x => x.label), ['See review', 'Open branch']);
  const branch = { id: 't1', status: 'running', role: 'backend', projectId: 'p', title: 'Add paging' };
  const quiet = detectAlerts(branch, { ...branch, status: 'done', mode: 'change', git: { commits: ['a'] }, autoReviewId: 'r1' }, names);
  assert.equal(quiet.length, 0);
});
