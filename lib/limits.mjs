// Run limits and estimates: how long and how much a task should take before it starts, when
// queued work should start and finish, and the limits every run must stay inside.
// Everything here is pure (no I/O) so it can be unit tested.

export const DEFAULT_LIMITS = {
  taskBudgetUsd: 2,     // per run; Claude Code stops the run when it is reached (0 = no limit)
  taskTimeoutMin: 30,   // per run; the server stops the run (0 = no limit)
  dailyBudgetUsd: 20,   // all runs today; new runs wait in the queue once reached (0 = no limit)
  warnAt: 0.8,          // warn when this share of a limit is used
};

const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

/** Keep only valid, non-negative numbers from a limits object. */
export function cleanLimits(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of LIMIT_KEYS) {
    const v = Number(raw[k]);
    if (raw[k] !== undefined && raw[k] !== '' && raw[k] !== null && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (out.warnAt !== undefined && (out.warnAt <= 0 || out.warnAt >= 1)) delete out.warnAt;
  return out;
}

/** Most specific wins: task, then role, then project, then app settings, then defaults. */
export function resolveLimits(app, project, role, task) {
  return { ...DEFAULT_LIMITS, ...cleanLimits(app), ...cleanLimits(project), ...cleanLimits(role), ...cleanLimits(task) };
}

/* ---------------- estimates ---------------- */

const MIN = 60000;
// Used until there are enough past runs to learn from. Deliberately round numbers.
const BASE = {
  change: { wallMs: 6 * MIN, costUsd: 0.6, turns: 25 },
  analyze: { wallMs: 3 * MIN, costUsd: 0.25, turns: 12 },
  report: { wallMs: 2 * MIN, costUsd: 0.15, turns: 6 },
};
const MODEL_FACTOR = {
  haiku: { wallMs: 0.6, costUsd: 0.3, turns: 1 },
  sonnet: { wallMs: 1, costUsd: 1, turns: 1 },
  opus: { wallMs: 1.4, costUsd: 4, turns: 1 },
};
export const MIN_SAMPLES = 5;

function modelFamily(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('haiku') ? 'haiku' : m.includes('opus') ? 'opus' : 'sonnet';
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function spread(values) {
  const s = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  return { p25: quantile(s, 0.25), p50: quantile(s, 0.5), p75: quantile(s, 0.75) };
}

function defaultEstimate(mode, model) {
  const b = BASE[mode] || BASE.change;
  const f = MODEL_FACTOR[modelFamily(model)];
  const est = {};
  for (const k of ['wallMs', 'costUsd', 'turns']) {
    const mid = b[k] * f[k];
    est[k] = { p25: mid * 0.5, p50: mid, p75: mid * 1.8 };
  }
  return { ...est, samples: 0, basis: 'default' };
}

/* ---------------- what the task text says ---------------- */

const STOP = new Set('the and for with from that this into onto have will should would could when then than them they their there here what which make please also just only some more most very each every about after before over under using use add new get set all any not but are was were been can its our your out off per via'.split(' '));

/** Lower-case content words of a task's title and details. */
export function taskWords(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9#+]+/).filter(w => w.length > 2 && !STOP.has(w)));
}

/** Share of words two tasks have in common (Jaccard index, 0..1). */
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
}

const SMALL_CUES = /\b(typo|typos|rename|renaming|comment|comments|readme|docs?|wording|spelling|bump|lint|format|formatting|minor|quick|small|tiny|one[- ]line|single (line|file|field))\b/g;
const LARGE_CUES = /\b(refactor\w*|rewrite|rewriting|migrat\w*|redesign\w*|re-?architect\w*|architecture|overhaul|across|entire|whole|end[- ]to[- ]end|e2e|framework|implement\w*|integrat\w*|new (feature|module|service|endpoint)s?|performance|security (audit|review)|all (the )?(controllers|services|endpoints|files|tests|pages|screens|tables))\b/g;

/**
 * How big the typed task looks: 'small' | 'normal' | 'large' | 'xlarge', and the factor the
 * default estimate is scaled by. A rough signal from wording only, used until there are
 * similar past tasks to learn from.
 */
export function taskSize(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return { size: 'normal', factor: 1 };
  const small = (t.match(SMALL_CUES) || []).length;
  const large = (t.match(LARGE_CUES) || []).length;
  const words = t.split(/\s+/).filter(Boolean).length;
  let score = Math.min(large, 2) - Math.min(small, 2);
  if (words > 80) score += 1;
  if (score <= -1) return { size: 'small', factor: 0.5 };
  if (score === 0) return { size: 'normal', factor: 1 };
  if (score === 1) return { size: 'large', factor: 1.6 };
  return { size: 'xlarge', factor: 2.4 };
}

const scaled = (est, f) => {
  const out = { ...est };
  for (const k of ['wallMs', 'costUsd', 'turns']) out[k] = { p25: est[k].p25 * f, p50: est[k].p50 * f, p75: est[k].p75 * f };
  return out;
};

export const MIN_SIMILAR = 3;
export const SIMILAR_AT = 0.25;

/**
 * Estimate a run from history. `history` is a list of finished runs:
 * { projectId, role, mode, model, ok, wallMs, costUsd, turns, text }.
 * With task `text`, past runs of similar tasks (same mode and model family) win once there are
 * MIN_SIMILAR of them. Otherwise it falls back from the exact project + role to wider groups
 * until one has MIN_SAMPLES runs, and scales that by the size the wording suggests.
 */
export function estimate(history, { projectId, role, mode, model, text = '' }) {
  const fam = modelFamily(model);
  const good = (history || []).filter(r => r && r.ok && r.mode === mode && modelFamily(r.model) === fam && r.wallMs > 0);
  const words = taskWords(text);
  if (words.size) {
    const similar = good.filter(r => similarity(words, taskWords(r.text)) >= SIMILAR_AT);
    if (similar.length >= MIN_SIMILAR) {
      return {
        wallMs: spread(similar.map(r => r.wallMs)),
        costUsd: spread(similar.map(r => r.costUsd || 0)),
        turns: spread(similar.map(r => r.turns || 0)),
        samples: similar.length,
        basis: 'similar',
        size: 'from similar tasks',
      };
    }
  }
  const { size, factor } = taskSize(text);
  const base = baseEstimate(good, { projectId, role, mode, model });
  return { ...scaled(base, factor), size };
}

function baseEstimate(good, { projectId, role, mode, model }) {
  const tiers = [
    ['project-role', r => r.projectId === projectId && r.role === role],
    ['role', r => r.role === role],
    ['mode', () => true],
  ];
  for (const [basis, match] of tiers) {
    const runs = good.filter(match);
    if (runs.length >= MIN_SAMPLES) {
      return {
        wallMs: spread(runs.map(r => r.wallMs)),
        costUsd: spread(runs.map(r => r.costUsd || 0)),
        turns: spread(runs.map(r => r.turns || 0)),
        samples: runs.length,
        basis,
      };
    }
  }
  return defaultEstimate(mode, model);
}

/* ---------------- queue ETA ---------------- */

/**
 * When queued jobs should start and finish.
 * running: [{ id, startedAt, estMs }]   queued (in queue order): [{ id, estMs }]
 * Returns { [id]: { start, end } } for every running and queued job. A running job that has
 * passed its estimate is assumed to finish in one more minute. With `paused` (daily limit
 * reached) queued jobs get no times.
 */
export function queueEta({ now, running = [], queued = [], slots = 1, paused = false }) {
  const out = {};
  const free = [];
  for (const j of running) {
    let end = j.startedAt + j.estMs;
    if (end <= now) end = now + MIN;
    out[j.id] = { start: j.startedAt, end };
    free.push(end);
  }
  if (paused) return out;
  while (free.length < Math.max(1, slots)) free.push(now);
  for (const j of queued) {
    free.sort((a, b) => a - b);
    const start = Math.max(now, free.shift());
    const end = start + j.estMs;
    out[j.id] = { start, end };
    free.push(end);
  }
  return out;
}

/* ---------------- spend ---------------- */

const sameDay = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

/** Total cost of runs that finished today (local time), across tasks and reports. */
export function spendToday(jobs, now = Date.now()) {
  let sum = 0;
  for (const j of jobs || []) {
    if (Array.isArray(j.runs) && j.runs.length) {
      for (const r of j.runs) if (sameDay(r.at, now)) sum += r.costUsd || 0;
    } else if (j.costUsd && sameDay(j.endedAt || j.startedAt || 0, now)) {
      sum += j.costUsd; // jobs recorded before run data existed
    }
  }
  return sum;
}

/** 'ok' | 'warn' | 'over' for a used amount against a limit (0 = no limit). */
export function limitState(used, limit, warnAt = DEFAULT_LIMITS.warnAt) {
  if (!limit) return 'ok';
  if (used >= limit) return 'over';
  if (used >= limit * warnAt) return 'warn';
  return 'ok';
}
