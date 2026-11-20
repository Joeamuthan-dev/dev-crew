import test from 'node:test';
import assert from 'node:assert/strict';
import { planHousekeeping, neededTaskIds, cleanHousekeeping, planSummary, planIsEmpty } from '../lib/housekeeping.mjs';

const DAY = 864e5;
const now = 100 * DAY;
const task = (over = {}) => ({
  id: 't1', title: 'Task', repo: 'api', mode: 'change', status: 'done', branch: 'agent/backend/x',
  worktree: '/wt/t1', cleaned: false, endedAt: now - 10 * DAY, ...over,
});
const wt = (over = {}) => ({ exists: true, dirty: false, sizeBytes: 1000, ...over });
const branch = (over = {}) => ({ repo: 'api', repoPath: '/repos/api', name: 'agent/backend/x', merged: false, mergedInto: '', commits: 2, ...over });
const plan = (tasks, facts, settings = {}, reports = []) => planHousekeeping({ tasks, reports, facts: { worktrees: {}, branches: [], orphanDirs: [], ...facts }, settings, now });

test('removes an old worktree but keeps its unmerged branch', () => {
  const p = plan([task()], { worktrees: { t1: wt() }, branches: [branch()] });
  assert.deepEqual(p.worktrees.map(w => w.taskId), ['t1']);
  assert.match(p.worktrees[0].reason, /more than 7 day/);
  assert.equal(p.branches.length, 0);
  assert.ok(p.keep.some(k => k.kind === 'branch' && /not merged/.test(k.reason)));
  assert.equal(p.bytes, 1000);
});

test('keeps a recent worktree whose branch is not merged', () => {
  const p = plan([task({ endedAt: now - DAY })], { worktrees: { t1: wt() }, branches: [branch()] });
  assert.equal(p.worktrees.length, 0);
});

test('a merged branch frees its worktree and is deleted, even when recent', () => {
  const p = plan([task({ endedAt: now - DAY })], { worktrees: { t1: wt() }, branches: [branch({ merged: true, mergedInto: 'main', commits: 0 })] });
  assert.equal(p.worktrees.length, 1);
  assert.match(p.worktrees[0].reason, /merged into main/);
  assert.deepEqual(p.branches.map(b => b.name), ['agent/backend/x']);
});

test('never removes a worktree with uncommitted changes, nor its branch', () => {
  const p = plan([task()], { worktrees: { t1: wt({ dirty: true }) }, branches: [branch({ merged: true, mergedInto: 'main' })] });
  assert.equal(p.worktrees.length, 0);
  assert.equal(p.branches.length, 0);
  assert.ok(p.keep.some(k => /uncommitted/.test(k.reason)));
});

test('never touches what a queued or blocked task still builds on', () => {
  const tasks = [task(), { id: 't2', status: 'blocked', prevId: 't1', dependsOn: ['t1'] }];
  const p = plan(tasks, { worktrees: { t1: wt() }, branches: [branch({ merged: true, mergedInto: 'main' })] });
  assert.equal(p.worktrees.length, 0);
  assert.equal(p.branches.length, 0);
  assert.ok(neededTaskIds(tasks).has('t1'));
});

test('never touches a running or queued task', () => {
  const p = plan([task({ status: 'running' })], { worktrees: { t1: wt() }, branches: [branch({ merged: true, mergedInto: 'main' })] });
  assert.equal(p.worktrees.length + p.branches.length + p.tasks.length, 0);
});

test('a worktree folder that is already gone is just marked cleaned', () => {
  const p = plan([task()], { worktrees: { t1: wt({ exists: false }) } });
  assert.deepEqual(p.fixups, ['t1']);
  assert.equal(p.worktrees.length, 0);
});

test('merged agent branches with no task are deleted; unmerged ones are listed', () => {
  const p = plan([], { branches: [branch({ name: 'agent/qa/old', merged: true, mergedInto: 'origin/main' }), branch({ name: 'agent/qa/wip', merged: false, commits: 3 })] });
  assert.deepEqual(p.branches.map(b => b.name), ['agent/qa/old']);
  assert.ok(p.keep.some(k => k.name === 'agent/qa/wip' && /3 commit/.test(k.reason)));
});

test('archives old finished tasks and stand-ups, but not while a worktree remains', () => {
  const tasks = [
    task({ id: 'a', mode: 'analyze', worktree: '', branch: '', endedAt: now - 40 * DAY }),
    task({ id: 'b', endedAt: now - 40 * DAY }), // worktree removed in this plan, so it can go too
    task({ id: 'c', endedAt: now - 40 * DAY }), // dirty worktree stays, so the task stays
    task({ id: 'd', mode: 'analyze', worktree: '', branch: '', endedAt: now - 5 * DAY }),
  ];
  const p = plan(tasks, { worktrees: { b: wt(), c: wt({ dirty: true }) } }, {}, [
    { id: 'r1', status: 'done', endedAt: now - 40 * DAY },
    { id: 'r2', status: 'done', endedAt: now - DAY },
  ]);
  assert.deepEqual(p.tasks.sort(), ['a', 'b']);
  assert.deepEqual(p.reports, ['r1']);
});

test('orphan worktree folders are removed and counted', () => {
  const p = plan([], { orphanDirs: [{ path: '/wt/x', sizeBytes: 5 * 1048576 }] });
  assert.equal(p.orphanDirs.length, 1);
  assert.equal(planSummary(p), '1 worktree (5.0 MB)');
});

test('settings and summary', () => {
  assert.deepEqual(cleanHousekeeping({ worktreeDays: '3', taskDays: -1, auto: true }), { worktreeDays: 3, taskDays: 30, auto: true });
  const p = plan([task({ endedAt: now - 2 * DAY })], { worktrees: { t1: wt() } }, { worktreeDays: 1 });
  assert.equal(p.worktrees.length, 1);
  const empty = plan([], {});
  assert.ok(planIsEmpty(empty));
  assert.equal(planSummary(empty), 'Nothing to clean up');
});
