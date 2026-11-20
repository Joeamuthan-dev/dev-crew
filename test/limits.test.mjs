import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLimits, cleanLimits, estimate, queueEta, spendToday, limitState, taskSize, taskWords, similarity, DEFAULT_LIMITS, MIN_SAMPLES, MIN_SIMILAR } from '../lib/limits.mjs';

const MIN = 60000;

test('resolveLimits: most specific wins, invalid values ignored', () => {
  const l = resolveLimits({ dailyBudgetUsd: 50 }, { taskBudgetUsd: 3 }, { taskTimeoutMin: 10 }, { taskBudgetUsd: 1, taskTimeoutMin: 'x' });
  assert.deepEqual(l, { taskBudgetUsd: 1, taskTimeoutMin: 10, dailyBudgetUsd: 50, warnAt: DEFAULT_LIMITS.warnAt });
});

test('cleanLimits drops negatives, blanks and a warnAt outside 0..1', () => {
  assert.deepEqual(cleanLimits({ taskBudgetUsd: -1, taskTimeoutMin: '', dailyBudgetUsd: 0, warnAt: 1.5 }), { dailyBudgetUsd: 0 });
});

test('estimate falls back to defaults without enough history', () => {
  const e = estimate([], { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet' });
  assert.equal(e.basis, 'default');
  assert.equal(e.samples, 0);
  assert.ok(e.wallMs.p25 < e.wallMs.p50 && e.wallMs.p50 < e.wallMs.p75);
});

test('estimate: haiku is cheaper than sonnet, opus dearer', () => {
  const q = m => estimate([], { projectId: 'p', role: 'qa', mode: 'analyze', model: m }).costUsd.p50;
  assert.ok(q('haiku') < q('sonnet') && q('sonnet') < q('opus'));
});

const run = (over = {}) => ({ projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet', ok: true, wallMs: 4 * MIN, costUsd: 0.4, turns: 20, ...over });

test('estimate uses the exact project and role once there are enough runs', () => {
  const hist = Array.from({ length: MIN_SAMPLES }, (_, i) => run({ wallMs: (i + 1) * MIN }));
  const e = estimate(hist, { projectId: 'p', role: 'backend', mode: 'change', model: 'claude-sonnet-x' });
  assert.equal(e.basis, 'project-role');
  assert.equal(e.samples, MIN_SAMPLES);
  assert.equal(e.wallMs.p50, 3 * MIN);
});

test('estimate widens to the role, then the mode', () => {
  const other = Array.from({ length: MIN_SAMPLES }, () => run({ projectId: 'q' }));
  assert.equal(estimate(other, { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet' }).basis, 'role');
  const otherRole = Array.from({ length: MIN_SAMPLES }, () => run({ projectId: 'q', role: 'qa' }));
  assert.equal(estimate(otherRole, { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet' }).basis, 'mode');
});

test('estimate ignores failed runs and other models', () => {
  const hist = [...Array.from({ length: 10 }, () => run({ ok: false })), ...Array.from({ length: 10 }, () => run({ model: 'opus' }))];
  assert.equal(estimate(hist, { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet' }).basis, 'default');
});

test('taskSize reads wording cues', () => {
  assert.equal(taskSize('Fix typo in README').size, 'small');
  assert.equal(taskSize('Add pagination to GET /invoices').size, 'normal');
  assert.equal(taskSize('Refactor the auth module').size, 'large');
  assert.equal(taskSize('Migrate all controllers to the new framework').size, 'xlarge');
  assert.equal(taskSize('').factor, 1);
});

test('estimate scales the default by the size of the typed task', () => {
  const q = text => estimate([], { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet', text });
  const small = q('Fix a typo in the docs');
  const normal = q('Add pagination to GET /invoices');
  const big = q('Refactor and migrate all services across the solution');
  assert.equal(normal.size, 'normal');
  assert.ok(small.wallMs.p50 < normal.wallMs.p50 && normal.wallMs.p50 < big.wallMs.p50);
  assert.ok(small.costUsd.p75 < normal.costUsd.p75 && normal.costUsd.p75 < big.costUsd.p75);
});

test('estimate prefers similar past tasks', () => {
  const hist = [
    ...Array.from({ length: MIN_SIMILAR }, () => run({ text: 'Add pagination to the invoices endpoint', wallMs: 2 * MIN })),
    ...Array.from({ length: 10 }, () => run({ text: 'Write integration tests for extraction jobs', wallMs: 20 * MIN })),
  ];
  const e = estimate(hist, { projectId: 'p', role: 'backend', mode: 'change', model: 'sonnet', text: 'Add pagination to invoices endpoint' });
  assert.equal(e.basis, 'similar');
  assert.equal(e.samples, MIN_SIMILAR);
  assert.equal(e.wallMs.p50, 2 * MIN);
});

test('similarity of task wording', () => {
  assert.ok(similarity(taskWords('Add pagination to invoices'), taskWords('pagination for invoices endpoint')) >= 0.25);
  assert.equal(similarity(taskWords('Fix login bug'), taskWords('Update Dockerfile')), 0);
});

test('queueEta fills free slots in order', () => {
  const now = 1000 * MIN;
  const eta = queueEta({
    now,
    slots: 2,
    running: [{ id: 'r1', startedAt: now - 2 * MIN, estMs: 5 * MIN }],
    queued: [{ id: 'a', estMs: 4 * MIN }, { id: 'b', estMs: 2 * MIN }],
  });
  assert.deepEqual(eta.r1, { start: now - 2 * MIN, end: now + 3 * MIN });
  assert.deepEqual(eta.a, { start: now, end: now + 4 * MIN });          // the free slot
  assert.deepEqual(eta.b, { start: now + 3 * MIN, end: now + 5 * MIN }); // after r1
});

test('queueEta: an overdue run finishes in a minute; paused queues get no times', () => {
  const now = 1000 * MIN;
  const eta = queueEta({ now, slots: 1, running: [{ id: 'r', startedAt: now - 10 * MIN, estMs: 5 * MIN }], queued: [{ id: 'q', estMs: MIN }], paused: true });
  assert.equal(eta.r.end, now + MIN);
  assert.equal(eta.q, undefined);
});

test('spendToday counts today\'s runs only, and old jobs without run data', () => {
  const now = new Date(2026, 10, 21, 15).getTime();
  const yesterday = new Date(2026, 10, 20, 15).getTime();
  const jobs = [
    { runs: [{ at: now - 1000, costUsd: 0.5 }, { at: yesterday, costUsd: 9 }] },
    { costUsd: 0.25, endedAt: now - 5000 },
    { costUsd: 7, endedAt: yesterday },
  ];
  assert.equal(spendToday(jobs, now), 0.75);
});

test('limitState', () => {
  assert.equal(limitState(5, 0), 'ok');
  assert.equal(limitState(5, 10), 'ok');
  assert.equal(limitState(8, 10), 'warn');
  assert.equal(limitState(10, 10), 'over');
});
