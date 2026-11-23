// Cost analytics: turns the run data every task and stand-up records (Phase 0) into the numbers
// and series the Costs page draws. Pure (no I/O) so it can be unit tested.

const ZERO_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const DAY = 864e5;
const FAILED = new Set(['failed', 'cancelled', 'stopped', 'blocked']);

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayStart = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

export function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return m || 'unknown';
}

/**
 * One row per Claude run, across tasks and stand-ups (live and archived). Jobs recorded before
 * run data existed count as one run with their total cost at the time they ended.
 */
export function collectRuns({ tasks = [], reports = [] }) {
  const rows = [];
  const add = (job, jobKind, r) => rows.push({
    at: r.at, day: dayKey(r.at), jobId: job.id, jobKind,
    projectId: job.projectId, role: jobKind === 'report' ? 'stand-up' : job.role, mode: jobKind === 'report' ? 'report' : job.mode,
    kind: r.kind || jobKind, model: modelFamily(r.model || job.model), ok: r.ok !== false, jobStatus: job.status, jobNoChanges: !!job.noChanges,
    costUsd: Number(r.costUsd) || 0, turns: Number(r.turns) || 0, wallMs: Number(r.wallMs) || 0,
    tokens: { ...ZERO_TOKENS(), ...(r.tokens || {}) },
    title: jobKind === 'report' ? `Stand-up ${job.date || ''}`.trim() : job.title,
  });
  for (const [list, jobKind] of [[tasks, 'task'], [reports, 'report']]) {
    for (const job of list) {
      if (Array.isArray(job.runs) && job.runs.length) for (const r of job.runs) add(job, jobKind, r);
      else if (job.costUsd) add(job, jobKind, { at: job.endedAt || job.startedAt || job.createdAt, costUsd: job.costUsd, turns: job.turns, ok: job.status === 'done', kind: jobKind });
    }
  }
  return rows.filter(r => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
}

/**
 * Knowledge-graph trials (scripts/graph-trial.mjs) as jobs, so their spend shows on the Costs
 * page. projectIdOf maps the trial's project name to a project id.
 */
export function trialJobs(trials, projectIdOf = n => n) {
  return (Array.isArray(trials) ? trials : []).filter(x => x && Array.isArray(x.runs) && x.runs.length).map(x => ({
    id: `trial-${x.startedAt}`, projectId: projectIdOf(x.project), role: 'graph-trial', mode: 'analyze', model: x.model,
    title: `Knowledge-graph trial (${(x.variants || []).join(', ')})`, status: 'done',
    runs: x.runs.map((r, i) => ({ at: (x.startedAt || 0) + i * 60000, costUsd: r.costUsd, turns: r.turns, wallMs: r.wallMs, tokens: r.tokens, ok: r.ok, kind: 'trial', model: x.model })),
  }));
}

const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function group(rows, key, name) {
  const map = new Map();
  for (const r of rows) {
    const k = key(r);
    const g = map.get(k) || { id: k, name: name ? name(k) : k, cost: 0, runs: 0 };
    g.cost += r.costUsd;
    g.runs += 1;
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

/**
 * Everything the Costs page shows, for a date range (inclusive YYYY-MM-DD days) and filters.
 * `tasks` are the task jobs (for estimates), `projectName(id)` names a project id.
 */
export function summarize(rows, { tasks = [], from, to, projectId, role, model, projectName = id => id, dailyLimit = 0, now = Date.now() } = {}) {
  const today = dayKey(now);
  const first = rows.length ? rows[0].day : today;
  const fromKey = from || first;
  const toKey = to || today;
  const lo = dayStart(fromKey);
  const hi = dayStart(toKey) + DAY;
  const sel = rows.filter(r => r.at >= lo && r.at < hi
    && (!projectId || r.projectId === projectId) && (!role || r.role === role) && (!model || r.model === model));

  const tokens = ZERO_TOKENS();
  let cost = 0;
  let wallMs = 0;
  for (const r of sel) {
    cost += r.costUsd;
    wallMs += r.wallMs;
    for (const k of Object.keys(tokens)) tokens[k] += r.tokens[k] || 0;
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;

  // every day in the range, zero-filled (at most a year so the chart stays readable)
  const daily = [];
  const byDay = new Map();
  for (const r of sel) { const d = byDay.get(r.day) || { cost: 0, runs: 0 }; d.cost += r.costUsd; d.runs += 1; byDay.set(r.day, d); }
  for (let t = Math.max(lo, hi - 366 * DAY); t < hi; t += DAY) {
    const k = dayKey(t + DAY / 2); // mid-day, safe across clock changes
    if (daily.length && daily[daily.length - 1].day === k) continue;
    daily.push({ day: k, ...(byDay.get(k) || { cost: 0, runs: 0 }) });
  }
  const firstUsed = daily.findIndex(d => d.runs);
  if (firstUsed > 2) daily.splice(0, Math.min(firstUsed - 2, Math.max(0, daily.length - 7)));

  // per job: what each task or stand-up cost in this range
  const jobs = new Map();
  for (const r of sel) {
    const j = jobs.get(r.jobId) || { jobId: r.jobId, jobKind: r.jobKind, title: r.title, projectId: r.projectId, role: r.role, model: r.model, status: r.jobStatus, noChanges: !!r.jobNoChanges, cost: 0, runs: 0 };
    j.cost += r.costUsd;
    j.runs += 1;
    jobs.set(r.jobId, j);
  }
  const jobList = [...jobs.values()];
  // a change task that finished without a commit is not a finished piece of work: it is waste
  const finished = jobList.filter(j => j.jobKind === 'task' && j.role !== 'graph-trial' && j.status === 'done' && !j.noChanges);
  const wastedCost = jobList.filter(j => FAILED.has(j.status) || j.noChanges).reduce((a, j) => a + j.cost, 0);

  // estimate accuracy: a task's first run against the range it was estimated at when assigned
  const est = [];
  const taskById = new Map(tasks.map(t => [t.id, t]));
  for (const j of jobList) {
    const t = taskById.get(j.jobId);
    const firstRun = t && (t.runs || []).find(r => (r.kind || 'task') === 'task');
    if (!t || !t.estimate || !firstRun || firstRun.ok === false) continue;
    const e = t.estimate.costUsd;
    est.push({ jobId: j.jobId, title: t.title, role: t.role, low: e.p25, mid: e.p50, high: e.p75, actual: Number(firstRun.costUsd) || 0, basis: t.estimate.basis });
  }
  const within = est.filter(e => e.actual >= e.low && e.actual <= e.high).length;

  return {
    range: { from: fromKey, to: toKey },
    totals: {
      cost, runs: sel.length, wallMs, tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      cacheHitRate: prompt ? tokens.cacheRead / prompt : 0,
      jobs: jobList.length,
    },
    tokens,
    daily,
    dailyLimit,
    byProject: group(sel, r => r.projectId, projectName),
    byRole: group(sel, r => r.role),
    byModel: group(sel, r => r.model),
    finished: { count: finished.length, cost: finished.reduce((a, j) => a + j.cost, 0), costPerTask: finished.length ? finished.reduce((a, j) => a + j.cost, 0) / finished.length : 0 },
    wasted: { cost: wastedCost, share: cost ? wastedCost / cost : 0 },
    top: jobList.sort((a, b) => b.cost - a.cost).slice(0, 10),
    estimates: {
      count: est.length,
      withinRange: est.length ? within / est.length : 0,
      medianRatio: median(est.filter(e => e.mid > 0).map(e => e.actual / e.mid)),
      rows: est.slice(-12).reverse(),
    },
  };
}

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The selected runs as CSV, one row per run. */
export function runsCsv(rows, projectName = id => id) {
  const head = ['time', 'day', 'project', 'role', 'kind', 'model', 'ok', 'status', 'cost_usd', 'turns', 'seconds', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'title'];
  const lines = rows.map(r => [
    new Date(r.at).toISOString(), r.day, projectName(r.projectId), r.role, r.kind, r.model, r.ok, r.jobStatus,
    r.costUsd.toFixed(4), r.turns, Math.round(r.wallMs / 1000),
    r.tokens.input, r.tokens.output, r.tokens.cacheRead, r.tokens.cacheWrite, r.title,
  ].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** Rows filtered the same way summarize() does, for the CSV export. */
export function filterRows(rows, { from, to, projectId, role, model } = {}) {
  const lo = from ? dayStart(from) : -Infinity;
  const hi = to ? dayStart(to) + DAY : Infinity;
  return rows.filter(r => r.at >= lo && r.at < hi && (!projectId || r.projectId === projectId) && (!role || r.role === role) && (!model || r.model === model));
}
