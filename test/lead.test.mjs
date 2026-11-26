import test from 'node:test';
import assert from 'node:assert/strict';
import { leadTree, finalBranches, startOf, leadState, leadPromptBlock, PRACTICE_NOTE } from '../lib/lead.mjs';
import { taskSystemPrompt } from '../lib/prompts.mjs';

const root = { id: 'L', lead: { practice: false }, status: 'done', plan: { status: 'started' } };
// two parallel steps in the api repo, merged by the Conflict Fixer, then reviewed; one web step
const api1 = { id: 'a1', leadId: 'L', mode: 'change', repo: 'api', branch: 'agent/backend/a1', status: 'done', baseSha: 's0', base: 'main', prevId: 'L', createdAt: 1 };
const api2 = { id: 'a2', leadId: 'L', mode: 'change', repo: 'api', branch: 'agent/qa/a2', status: 'done', baseSha: 's0', base: 'main', prevId: 'L', createdAt: 2 };
const merge = { id: 'm', leadId: 'L', mode: 'change', repo: 'api', branch: 'agent/conflicts/m', status: 'done', baseSha: 's1', base: 'agent/backend/a1', prevId: 'a1', mergeFrom: ['a2'], createdAt: 3 };
const web = { id: 'w', leadId: 'L', mode: 'change', repo: 'web', branch: 'agent/frontend/w', status: 'done', baseSha: 'w0', base: 'main', prevId: 'L', createdAt: 4 };
const review = { id: 'r', leadId: 'L', mode: 'analyze', repo: 'api', status: 'done', review: { branch: 'agent/conflicts/m' }, createdAt: 5 };
const all = [review, web, merge, api2, api1, root, { id: 'other', mode: 'change', branch: 'x', status: 'done' }];

test('a lead ticket ends with one branch per repo: the merged one, not the parallel ones', () => {
  assert.deepEqual(leadTree('L', all).map(t => t.id).sort(), ['a1', 'a2', 'm', 'r', 'w']);
  assert.deepEqual(finalBranches(leadTree('L', all)).map(t => t.id).sort(), ['m', 'w']);
  // the diff is taken from where the repo's work started, not from the merge's own base
  assert.deepEqual(startOf(leadTree('L', all), 'api'), { sha: 's0', base: 'main' });
  // a step that changed nothing is not a result
  assert.deepEqual(finalBranches([{ ...web, noChanges: true }]).length, 0);
});

test('where a lead ticket stands', () => {
  assert.equal(leadState({ ...root, status: 'running' }, all).state, 'planning');
  assert.equal(leadState({ ...root, status: 'failed' }, all).state, 'stuck');
  assert.equal(leadState({ ...root, plan: { status: 'proposed' } }, all).state, 'stuck');
  assert.equal(leadState(root, [...all, { id: 'q', leadId: 'L', status: 'queued' }]).state, 'working');
  const stuck = leadState(root, [...all, { id: 'f', leadId: 'L', status: 'blocked', title: 'Add tests' }]);
  assert.equal(stuck.state, 'stuck');
  assert.match(stuck.why, /"Add tests" \(blocked\)/);
  assert.deepEqual(leadState(root, all).finals.sort(), ['m', 'w']);
  assert.equal(leadState({ id: 'x' }, all), null);
});

test('the lead is told to review first and that the plan starts on its own; practice steps are told why', () => {
  const p = { name: 'DataEz', repos: [{ name: 'api', path: '/api' }], roles: {}, activeRoles: ['backend', 'qa', 'reviewer', 'conflicts'] };
  const sp = taskSystemPrompt(p, 'backend', 'analyze', { plan: true, canMerge: true, lead: leadPromptBlock({ roleName: 'Backend Engineer' }) });
  assert.match(sp, /You lead this ticket as the Backend Engineer/);
  assert.match(sp, /review the ticket and the code/);
  assert.match(sp, /nothing is pushed/);
  assert.doesNotMatch(sp, /practice run/);
  assert.match(leadPromptBlock({ practice: true }), /practice run/);
  const step = taskSystemPrompt(p, 'qa', 'change', { cwd: '/w', branch: 'b', base: 'main', practice: true });
  assert.ok(step.includes(PRACTICE_NOTE));
});
