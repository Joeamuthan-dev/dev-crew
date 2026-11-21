import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRuns, summarize, runsCsv, filterRows, dayKey, modelFamily } from '../lib/analytics.mjs';

const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const run = (at, cost, over = {}) => ({ at, kind: 'task', model: 'claude-sonnet-x', ok: true, costUsd: cost, turns: 3, wallMs: 60000, tokens: { input: 10, output: 100, cacheRead: 300, cacheWrite: 90 }, ...over });

const tasks = [
  { id: 'a', projectId: 'p1', role: 'backend', mode: 'change', title: 'Add pagination', status: 'done',
    estimate: { costUsd: { p25: 0.2, p50: 0.4, p75: 0.8 } },
    runs: [run(D(2026, 11, 19), 0.5), run(D(2026, 11, 20), 0.2, { kind: 'followup' })] },
  { id: 'b', projectId: 'p2', role: 'qa', mode: 'analyze', title: 'Find flaky tests', status: 'failed',
    estimate: { costUsd: { p25: 0.1, p50: 0.2, p75: 0.3 } },
    runs: [run(D(2026, 11, 21), 1.0, { model: 'claude-opus-x', ok: false })] },
  { id: 'old', projectId: 'p1', role: 'backend', mode: 'change', title: 'Before run data', status: 'done', costUsd: 0.3, endedAt: D(2026, 11, 18) },
];
const reports = [{ id: 'r', projectId: 'p1', date: '2026-11-21', status: 'done', runs: [run(D(2026, 11, 21, 9), 0.1, { kind: 'report', model: 'claude-haiku-x' })] }];
const now = D(2026, 11, 21, 18);

test('collectRuns flattens tasks, follow-ups, stand-ups and legacy jobs', () => {
  const rows = collectRuns({ tasks, reports });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.day), ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-21']);
  assert.equal(rows.find(r => r.jobId === 'r').role, 'stand-up');
  assert.equal(rows.find(r => r.jobId === 'old').model, 'unknown');
});

test('summarize: totals, cache hit rate, daily series, breakdowns', () => {
  const rows = collectRuns({ tasks, reports });
  const s = summarize(rows, { tasks, from: '2026-11-15', to: '2026-11-21', now, projectName: id => id.toUpperCase(), dailyLimit: 20 });
  assert.equal(s.totals.runs, 5);
  assert.ok(Math.abs(s.totals.cost - 2.1) < 1e-9);
  // 4 runs with tokens: input 40, cacheRead 1200, cacheWrite 360 -> 1200 / 1600
  assert.equal(s.totals.cacheHitRate, 0.75);
  assert.equal(s.daily.length, 7);
  assert.deepEqual(s.daily.map(d => d.day)[0], '2026-11-15');
  assert.ok(Math.abs(s.daily.find(d => d.day === '2026-11-21').cost - 1.1) < 1e-9);
  assert.equal(s.daily.find(d => d.day === '2026-11-16').cost, 0);
  // p1 = 0.3 (legacy) + 0.5 + 0.2 + 0.1 (stand-up) = 1.1; p2 = 1.0: ranked by cost, named
  assert.deepEqual(s.byProject.map(p => p.name), ['P1', 'P2']);
  assert.ok(Math.abs(s.byProject[0].cost - 1.1) < 1e-9);
  assert.deepEqual(s.byModel.map(m => m.id).sort(), ['haiku', 'opus', 'sonnet', 'unknown']);
  assert.equal(s.dailyLimit, 20);
});

test('summarize: finished cost per task, wasted spend, top tasks, estimates', () => {
  const rows = collectRuns({ tasks, reports });
  const s = summarize(rows, { tasks, now, from: '2026-11-01', to: '2026-11-21' });
  assert.equal(s.finished.count, 2); // a and old
  assert.ok(Math.abs(s.finished.costPerTask - 0.5) < 1e-9); // (0.7 + 0.3) / 2
  assert.ok(Math.abs(s.wasted.cost - 1.0) < 1e-9);
  assert.equal(s.top[0].jobId, 'b');
  // only task a: first run 0.5 inside 0.2..0.8; b's first run failed so it is not counted
  assert.equal(s.estimates.count, 1);
  assert.equal(s.estimates.withinRange, 1);
  assert.equal(s.estimates.medianRatio, 1.25);
});

test('filters by project, role and model', () => {
  const rows = collectRuns({ tasks, reports });
  assert.equal(summarize(rows, { tasks, now, from: '2026-11-01', projectId: 'p2' }).totals.runs, 1);
  assert.equal(summarize(rows, { tasks, now, from: '2026-11-01', role: 'backend' }).totals.runs, 3);
  assert.equal(summarize(rows, { tasks, now, from: '2026-11-01', model: 'haiku' }).totals.runs, 1);
  assert.equal(filterRows(rows, { from: '2026-11-20', to: '2026-11-20' }).length, 1);
});

test('an empty range is all zeros, not NaN', () => {
  const s = summarize([], { now });
  assert.equal(s.totals.cost, 0);
  assert.equal(s.totals.cacheHitRate, 0);
  assert.equal(s.finished.costPerTask, 0);
  assert.equal(s.wasted.share, 0);
  assert.equal(s.daily.length, 1);
});

test('CSV has a header, one row per run, and quotes awkward titles', () => {
  const rows = collectRuns({ tasks: [{ ...tasks[0], title: 'Say "hi", then go' }], reports: [] });
  const csv = runsCsv(rows, id => `Project ${id}`);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^time,day,project,role/);
  assert.match(lines[1], /,"Say ""hi"", then go"$/);
  assert.match(lines[1], /Project p1,backend,task,sonnet,true,done,0\.5000/);
});

test('helpers', () => {
  assert.equal(dayKey(D(2026, 1, 5)), '2026-01-05');
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily(''), 'unknown');
});
