// Dev Crew server: a queue of agent runs, a daily stand-up scheduler, a small JSON API and
// a live event stream for the dashboard. Listens on 127.0.0.1 only: these agents edit code.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, refreshRepos } from './lib/config.mjs';
import { ROLES, roleById, roleKind } from './lib/roles.mjs';
import { parseReview, reviewMarkdown, postReview } from './lib/review.mjs';
import * as G from './lib/git.mjs';
import { runClaude, claudeFeatures, describeEvent, toolPolicy, resetClaude } from './lib/claude.mjs';
import { settingsFromForm, maskSettings } from './lib/settings.mjs';
import { collectRuns, summarize, runsCsv, filterRows, dayKey, trialJobs } from './lib/analytics.mjs';
import { taskSystemPrompt, taskPrompt, reportSystemPrompt, reportPrompt, parseReport, summaryOf } from './lib/prompts.mjs';
import { createStore, newId } from './lib/store.mjs';
import { createMonday } from './lib/monday.mjs';
import { search as searchPeople, directory, contactsFor } from './lib/people.mjs';
import { checkRequest } from './lib/guard.mjs';
import { resolveLimits, cleanLimits, estimate, queueEta, spendToday, limitState } from './lib/limits.mjs';
import { parseHandoffs, parsePlan, depsState, startPoint, handoffPolicy, MAX_CHAIN_DEPTH } from './lib/handoffs.mjs';
import { planHousekeeping, planSummary, planIsEmpty } from './lib/housekeeping.mjs';
import { gatherFacts, runPlan, clearTmp, canonical } from './lib/cleanup.mjs';
import { detectProject, findRepos } from './lib/detect.mjs';
import { refusedCommands, mergeRefused, ruleProblem } from './lib/permissions.mjs';
import { findGraph, graphDigest, graphPromptBlock, writeMcpConfig, graphToolRules } from './lib/graph.mjs';
import { readRaw, writeRaw, projectFromForm, upsertProject, removeProject, peopleFromForm } from './lib/configfile.mjs';

const DATA = path.join(ROOT, 'data');
const WT_DIR = path.join(DATA, 'worktrees');
const TMP = path.join(DATA, 'tmp');
const PUBLIC = path.join(ROOT, 'public');

let cfg = loadConfig();
const store = createStore(DATA);
clearTmp(TMP); // system-prompt files left by runs that were interrupted
const monday = createMonday(() => cfg);
async function refreshMonday(projectId) {
  await monday.refresh(projectId);
  emit('monday', monday.snapshot());
}
setInterval(() => refreshMonday().catch(e => console.warn(e.message)), 120000);
const S = store.state;

for (const t of S.tasks) {
  // tasks from before "No changes" existed: a finished change task with no commits made nothing
  if (t.status === 'done' && t.mode === 'change' && t.git && !t.git.commits.length && !t.git.uncommitted && !t.mergeTarget) t.noChanges = true;
  if (t.status === 'running') { t.status = 'failed'; t.error = 'Interrupted: the server stopped during this run. Send a follow-up to continue it.'; }
}
// Tasks from before refused commands were kept on the task: read them back from the log once.
for (const t of S.tasks.slice(0, 60)) {
  if (t.refused) continue;
  try {
    const fresh = [];
    for (const l of store.readLog(t.id)) {
      const m = l.kind === 'warn' && /^Blocked by the crew's permissions: (.*)$/s.exec(l.text || '');
      if (!m) continue;
      for (const part of m[1].split(' · ')) {
        const i = part.indexOf(': ');
        if (i > 0) fresh.push({ tool: part.slice(0, i), command: part.slice(i + 2).trim() });
      }
    }
    if (fresh.length) t.refused = mergeRefused([], refusedCommands(fresh.map(f => ({ tool_name: f.tool, tool_input: { command: f.command } }))));
  } catch { /* no log */ }
}
for (const r of S.reports) {
  if (r.status === 'running' || r.status === 'queued') { r.status = 'failed'; r.error = 'Interrupted: the server stopped before this report finished.'; }
}
const project = id => cfg.projects.find(p => p.id === id);
// A role can leave the config (a custom one removed) while old tasks still name it.
const roleName = id => (roleById(id) || {}).name || id;
const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The very first start counts as today's run, so installing doesn't fire five reports at once.
if (!S.meta.lastDaily) S.meta.lastDaily = todayStr();
store.save();

/* ---------------- live events ---------------- */

const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

function touchTask(t) { store.save(); emit('task', t); queueChanged(); }
function touchReport(r) { store.save(); emit('report', r); queueChanged(); }

// ETAs and spend depend on every job, so send them once after a burst of changes.
let queueTimer = null;
function queueChanged() {
  if (queueTimer) return;
  queueTimer = setTimeout(() => { queueTimer = null; emitQueue(); }, 200);
}
function emitQueue() {
  if (!clients.size) return;
  emit('queue', { etas: etas(), spend: spendView() });
}
setInterval(emitQueue, 30000);
function log(id, kind, text) {
  const entry = { at: Date.now(), kind, text };
  store.appendLog(id, entry);
  emit('log', { id, ...entry });
}

/* ---------------- the queue ---------------- */

const running = new Map(); // job id -> { kill, cancelled }

const taskById = id => S.tasks.find(x => x.id === id);

function nextJob() {
  let best = null;
  for (const t of S.tasks) {
    if (t.status !== 'queued' || (best && t.queuedAt >= best.job.queuedAt)) continue;
    if (depsState(t, taskById).state !== 'ready') continue; // waits for the tasks it depends on
    best = { kind: 'task', job: t };
  }
  for (const r of S.reports) if (r.status === 'queued' && (!best || r.queuedAt < best.job.queuedAt)) best = { kind: 'report', job: r };
  return best;
}

/* ---------------- limits, estimates and ETA ---------------- */

const jobModel = j => j.kind === 'report'
  ? cfg.settings.reportModel || cfg.settings.model
  : j.model || ((project(j.projectId) || { roles: {} }).roles[j.role] || {}).model || cfg.settings.model;

const taskText = t => `${t.title || ''}\n${t.details || ''}`;

/** Every finished run, with the task's project, role, mode and wording, to learn estimates from. */
function runHistory() {
  const out = [];
  // Only a task's first run describes the task as typed; follow-ups are a different amount of work.
  for (const t of S.tasks) for (const r of t.runs || []) out.push({ projectId: t.projectId, role: t.role, mode: t.mode, model: r.model, ok: r.ok, wallMs: r.wallMs, costUsd: r.costUsd, turns: r.turns, text: r.kind === 'task' ? taskText(t) : '' });
  for (const rp of S.reports) for (const r of rp.runs || []) out.push({ projectId: rp.projectId, role: 'report', mode: 'report', model: r.model, ok: r.ok, wallMs: r.wallMs, costUsd: r.costUsd, turns: r.turns });
  return out;
}

function estimateFor({ projectId, role, mode, model, text = '' }) {
  return estimate(runHistory(), { projectId, role, mode, model, text });
}

function limitsFor(job) {
  const p = project(job.projectId);
  if (job.kind === 'report' || !job.role) return resolveLimits(cfg.settings.limits, p && p.limits);
  return resolveLimits(cfg.settings.limits, p && p.limits, p && (p.roles[job.role] || {}).limits, job.limits);
}

const todaysSpend = () => spendToday([...S.tasks, ...S.reports]);

/** True when today's spend has reached the daily limit: queued runs wait. */
function dailyLimitReached() {
  const daily = cfg.settings.limits.dailyBudgetUsd;
  return daily > 0 && todaysSpend() >= daily;
}

function spendView() {
  const today = todaysSpend();
  const daily = cfg.settings.limits.dailyBudgetUsd;
  return { today, daily, state: limitState(today, daily, cfg.settings.limits.warnAt), paused: dailyLimitReached() };
}

function etas() {
  // A task keeps the estimate made from its wording when it was assigned; reports use history.
  const est = j => (j.kind === 'task' && j.estimate ? j.estimate : estimateFor({ projectId: j.projectId, role: j.role, mode: j.mode || 'report', model: jobModel(j), text: j.kind === 'task' ? taskText(j) : '' })).wallMs.p50;
  const jobs = [...S.tasks.map(t => ({ ...t, kind: 'task' })), ...S.reports.map(r => ({ ...r, kind: 'report', mode: 'report' }))];
  return queueEta({
    now: Date.now(),
    slots: cfg.settings.maxConcurrent,
    paused: dailyLimitReached(),
    running: jobs.filter(j => j.status === 'running').map(j => ({ id: j.id, startedAt: j.startedAt, estMs: est(j) })),
    queued: jobs.filter(j => j.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt).map(j => ({ id: j.id, estMs: est(j) })),
  });
}

/** Stops a run at its time limit, with a warning in the log first. Returns a cancel function. */
function watchTimeout(job, limits, handle) {
  const ms = limits.taskTimeoutMin * 60000;
  if (!ms) return () => {};
  const warn = setTimeout(() => log(job.id, 'warn', `${Math.round(limits.warnAt * 100)}% of the ${limits.taskTimeoutMin}-minute time limit used.`), ms * limits.warnAt);
  const stop = setTimeout(() => {
    handle.limitHit = 'timeout';
    log(job.id, 'warn', `Time limit reached (${limits.taskTimeoutMin} min). Stopping the run.`);
    if (handle.kill) handle.kill();
  }, ms);
  return () => { clearTimeout(warn); clearTimeout(stop); };
}

/**
 * Queued tasks whose dependency failed, was cancelled or stopped become 'blocked'; blocked tasks
 * go back to the queue once that dependency is done (for example after Continue).
 */
function refreshBlocked() {
  for (const t of S.tasks) {
    if (!(t.dependsOn || []).length || (t.status !== 'queued' && t.status !== 'blocked')) continue;
    const d = depsState(t, taskById);
    if (d.state === 'blocked' && t.status === 'queued') {
      t.status = 'blocked';
      t.error = d.reason;
      touchTask(t);
    } else if (d.state !== 'blocked' && t.status === 'blocked') {
      t.status = 'queued';
      t.error = '';
      t.queuedAt = Date.now();
      touchTask(t);
    }
  }
}

let budgetNoticeDay = '';
function pump() {
  refreshBlocked();
  while (running.size < Math.max(1, cfg.settings.maxConcurrent)) {
    const next = nextJob();
    if (!next) return;
    if (dailyLimitReached()) {
      if (budgetNoticeDay !== todayStr()) {
        budgetNoticeDay = todayStr();
        console.log(`Daily spend limit ($${cfg.settings.limits.dailyBudgetUsd}) reached: queued runs wait until tomorrow or until the limit is raised.`);
        emitQueue();
      }
      return;
    }
    const handle = { kill: null, cancelled: false };
    running.set(next.job.id, handle);
    next.job.status = 'running';
    next.job.startedAt = Date.now();
    (next.kind === 'task' ? execTask(next.job, handle) : execReport(next.job, handle))
      .catch(e => console.error('job crashed', e))
      .finally(() => { running.delete(next.job.id); pump(); });
  }
}

/**
 * Keep one entry per Claude run on a task or report (a follow-up is a new run), plus running
 * totals. This is what run-time estimates and the cost analytics page are built from.
 */
function recordRun(job, res, model, kind) {
  const s = res.stats || {};
  const tokens = s.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  (job.runs = job.runs || []).push({
    at: Date.now(), kind, model: (s.models && s.models[0]) || model || '', ok: !!res.ok,
    costUsd: res.costUsd, turns: res.turns, wallMs: s.wallMs || 0, apiMs: s.apiMs || 0, tokens,
  });
  const tot = job.tokens || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const k of Object.keys(tot)) tot[k] += tokens[k] || 0;
  job.tokens = tot;
  job.wallMs = (job.wallMs || 0) + (s.wallMs || 0);
}

/**
 * The project's knowledge graph for one run (project option "knowledgeGraph"): a digest in the
 * system prompt ("summary"), or graphify's read-only graph tools over MCP ("tools").
 */
function graphContext(p, repo, t, tmpDir) {
  const out = { block: '', mcp: '', tools: [] };
  const mode = p.knowledgeGraph || 'off';
  if (mode === 'off') return out;
  const where = repo || (p.repos.length === 1 ? p.repos[0] : null);
  const g = where && findGraph(where.path);
  if (!g) {
    log(t.id, 'warn', `The knowledge graph is on for ${p.name}, but ${where ? where.name : 'this task'} has no graphify-out folder. Run graphify there first; this run goes without it.`);
    return out;
  }
  if (mode === 'summary' && g.report) {
    out.block = graphPromptBlock('summary', { digest: graphDigest(fs.readFileSync(g.report, 'utf8')), builtAt: g.builtAt });
  } else if (mode === 'tools' && g.graph) {
    out.mcp = writeMcpConfig(g.graph, tmpDir);
    out.tools = graphToolRules();
    out.block = graphPromptBlock('tools', { builtAt: g.builtAt });
  }
  if (out.block) log(t.id, 'sys', `Using the knowledge graph of ${where.name} (${mode === 'tools' ? 'graph tools' : 'digest in the prompt'})`);
  return out;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
}

async function execTask(t, handle) {
  t.error = '';
  touchTask(t);
  let repo = null;
  try {
    const p = project(t.projectId);
    if (!p) throw new Error(`Project "${t.projectId}" is no longer in the config.`);
    refreshRepos(p);
    repo = p.repos.find(r => r.name === t.repo) || null;
    // A follow-on task builds on the task before it: a change starts from its branch, a read-only
    // task reads its worktree. Resolved now, because a plan's earlier steps only get branches
    // when they run.
    const prev = t.prevId ? taskById(t.prevId) : null;
    const role = roleById(t.role);
    if (!role) throw new Error(`The role "${t.role}" is no longer in the config.`);
    const kind = role.kind || '';
    // A review handed on from another task reviews that task's branch.
    if (kind === 'review' && !(t.review && t.review.branch) && prev && prev.branch) {
      t.review = { branch: prev.branch, base: prev.base || '', prNumber: '' };
    }
    // Remote branches move: fetch before a review or a merge that names one.
    if (repo && !t.sessionId && ((kind === 'review' && t.review) || (kind === 'conflicts' && t.mergeTarget))) {
      const refs = kind === 'review' ? [t.review.branch, t.review.base] : [t.mergeTarget, t.base];
      if (refs.some(r => String(r).startsWith('origin/')) && await G.fetchOrigin(repo.path)) log(t.id, 'sys', 'Fetched the latest branches from origin');
    }
    if (kind === 'conflicts' && t.mergeTarget && repo && !(await G.refExists(repo.path, t.mergeTarget))) throw new Error(`The branch to merge in, ${t.mergeTarget}, no longer exists.`);
    const sp = startPoint(prev, t.mode, t.repo);
    if (t.mode === 'change' && !t.worktree && !t.base && sp.base) t.base = sp.base;
    const readFrom = t.mode === 'analyze' && sp.readFrom && fs.existsSync(sp.readFrom) ? sp.readFrom : '';
    let cwd;
    let addDirs = [];
    if (t.mode === 'change') {
      if (!repo) throw new Error(`Repo "${t.repo}" was not found in ${p.path}.`);
      if (t.cleaned) throw new Error('This task\'s worktree was cleaned up. Assign a new task to continue on that branch.');
      if (!t.worktree) {
        const base = t.base || (await G.currentBranch(repo.path)) || 'HEAD';
        const d = new Date();
        const branch = `agent/${t.role}/${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${slug(t.title)}-${t.id.slice(-4)}`;
        const dir = path.join(WT_DIR, t.projectId, t.id);
        log(t.id, 'sys', `Creating branch ${branch} from ${base} in its own worktree`);
        t.baseSha = await G.addWorktree(repo.path, dir, branch, base);
        Object.assign(t, { base, branch, worktree: dir });
        touchTask(t);
      } else if (!fs.existsSync(t.worktree)) {
        throw new Error('The worktree folder for this task is missing.');
      }
      cwd = t.worktree;
    } else if (readFrom) {
      cwd = readFrom;
      log(t.id, 'sys', `Reading the work of "${prev.title}" in its worktree (branch ${prev.branch})`);
    } else if (repo) {
      cwd = repo.path;
    } else {
      cwd = p.path;
      addDirs = p.repos.map(r => r.path).filter(rp => path.relative(cwd, rp).startsWith('..'));
    }
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);

    const followup = t.pendingFollowup || '';
    t.pendingFollowup = '';
    const resume = followup && t.sessionId ? t.sessionId : undefined;
    const prompt = resume ? followup : taskPrompt(t) + (followup ? `\n\nAlso from the owner: ${followup}` : '');
    if (followup) log(t.id, 'you', followup);

    const model = t.model || (p.roles[t.role] || {}).model || cfg.settings.model;
    const limits = limitsFor(t);
    t.appliedLimits = limits;
    if (limits.taskBudgetUsd > 0 && !(await claudeFeatures(cfg.settings.claudeCommand)).maxBudget) {
      log(t.id, 'warn', 'This Claude Code version has no --max-budget-usd, so the per-task cost limit cannot be enforced. Update with: claude update');
    }
    const graphCtx = graphContext(p, repo, t, TMP);
    const run = runClaude({
      command: cfg.settings.claudeCommand,
      cwd,
      prompt,
      mcpConfig: graphCtx.mcp,
      extraTools: graphCtx.tools,
      systemPrompt: taskSystemPrompt(p, t.role, t.mode, {
        graph: graphCtx.block,
        cwd, branch: t.branch, base: t.base, readFrom,
        prev: prev ? { role: prev.role, title: prev.title, branch: prev.branch, summary: prev.summary } : null,
        // a plan step's next steps are the plan's own, so it proposes no handoffs of its own
        handoffs: (t.chainDepth || 0) >= MAX_CHAIN_DEPTH || (kind === 'review' && t.review) || t.origin === 'plan' ? 'off' : policyFor(p),
        plan: !!t.planTask,
        review: t.review, mergeTarget: t.mergeTarget,
      }),
      mode: t.mode,
      kind,
      extraCommands: p.allowCommands,
      model,
      resume,
      addDirs,
      permissionMode: cfg.settings.permissionMode,
      strictMcp: cfg.settings.strictMcp,
      inheritEnv: cfg.settings.inheritClaudeEnv,
      maxBudgetUsd: limits.taskBudgetUsd,
      tmpDir: TMP,
      onEvent: ev => {
        if (ev.type === 'system' && ev.session_id && ev.session_id !== t.sessionId) { t.sessionId = ev.session_id; store.save(); }
        for (const l of describeEvent(ev, cwd)) log(t.id, l.kind, l.text);
      },
    });
    handle.kill = run.kill;
    if (handle.cancelled) run.kill();
    const unwatch = watchTimeout(t, limits, handle);
    const res = await run.done.finally(() => {
      unwatch();
      if (graphCtx.mcp) fs.rmSync(graphCtx.mcp, { force: true });
    });
    if (res.budgetHit) handle.limitHit = 'budget';

    if (res.sessionId) t.sessionId = res.sessionId;
    t.costUsd = (t.costUsd || 0) + res.costUsd;
    t.turns = (t.turns || 0) + res.turns;
    recordRun(t, res, model, followup ? 'followup' : 'task');
    if (res.denials.length) {
      const what = res.denials.map(d => d.tool_name + (d.tool_input && d.tool_input.command ? `: ${d.tool_input.command}` : '')).join(' · ');
      log(t.id, 'warn', `Blocked by the crew's permissions: ${what}`.slice(0, 800));
      // kept on the task, so the panel can show them and offer to allow them for the project
      const fresh = refusedCommands(res.denials);
      if (fresh.length) t.refused = mergeRefused(t.refused, fresh);
    }
    if (res.result) {
      t.result = res.result;
      t.summary = summaryOf(res.result);
      (t.history = t.history || []).push({ at: Date.now(), prompt: followup || t.title, result: res.result });
    }
    if (t.mode === 'change' && t.baseSha) t.git = await G.branchSummary(repo.path, t.baseSha, t.branch, t.worktree);
    // A change task with no commits and nothing uncommitted made nothing: say so, never 'done' alone.
    if (t.mode === 'change' && t.git && res.ok && !handle.cancelled && !handle.limitHit) {
      if (!t.git.commits.length && !t.git.uncommitted && !t.mergeTarget) t.noChanges = true; else delete t.noChanges;
    }
    if (kind === 'review' && t.review && res.result) {
      const found = parseReview(res.result);
      if (found) t.review = { ...t.review, result: found, posted: null };
      else log(t.id, 'warn', 'The review had no "## Review" block, so there is nothing to post. The report is still below.');
    }
    if (kind === 'conflicts' && t.mergeTarget && t.worktree) {
      // Did the merge land? A half-finished merge is reported, never left looking done.
      const unfinished = await G.mergeInProgress(t.worktree);
      const merged = !unfinished && await G.isAncestor(t.worktree, t.mergeTarget, 'HEAD');
      t.merge = { state: unfinished ? 'unfinished' : merged ? 'merged' : 'not-merged', at: Date.now() };
      if (unfinished) log(t.id, 'warn', 'The merge is not finished: conflicts are still open in the worktree. Send a follow-up to finish it, or assign it again.');
      else if (merged) log(t.id, 'sys', `${t.branch} now contains ${t.mergeTarget}.`);
    }
    t.stopReason = '';
    if (handle.cancelled) { t.status = 'cancelled'; t.error = 'Cancelled.'; }
    else if (handle.limitHit) {
      t.status = 'stopped';
      t.stopReason = handle.limitHit;
      t.error = handle.limitHit === 'budget'
        ? `Stopped at the $${limits.taskBudgetUsd} cost limit for this run. Press Continue to resume with a new allowance.`
        : `Stopped at the ${limits.taskTimeoutMin}-minute time limit for this run. Press Continue to resume.`;
      log(t.id, 'warn', t.error);
    }
    else if (res.ok && t.merge && t.merge.state === 'unfinished') {
      t.status = 'failed';
      t.error = 'The merge was left half-finished. Send a follow-up to finish it, or abort it with a new task.';
    }
    else if (res.ok) { t.status = 'done'; takeNextSteps(t, p, res.result); }
    else { t.status = 'failed'; t.error = res.error; log(t.id, 'err', res.error); }
  } catch (e) {
    t.status = handle.cancelled ? 'cancelled' : 'failed';
    t.error = e.message;
    log(t.id, 'err', e.message);
  }
  t.endedAt = Date.now();
  touchTask(t);
}

async function execReport(r, handle) {
  touchReport(r);
  try {
    const p = project(r.projectId);
    if (!p) throw new Error(`Project "${r.projectId}" is no longer in the config.`);
    refreshRepos(p);
    if (!p.exists) throw new Error(`Project folder not found: ${p.path}. Clone the repos there or fix "folder" in the config.`);
    const since = Date.now() - 3 * 864e5;
    const tasks = S.tasks
      .filter(t => t.projectId === p.id && (t.createdAt > since || t.status === 'queued' || t.status === 'running'))
      .map(t => ({
        role: roleName(t.role), title: t.title, status: t.status, branch: t.branch,
        commits: t.git ? t.git.commits.length : 0, summary: t.summary, error: t.status === 'failed' ? t.error : '',
      }));
    const repos = [];
    for (const rp of p.repos) repos.push({ name: rp.name, ...(await G.recentActivity(rp.path)) });
    const board = monday.snapshot().boards[p.id];
    const tickets = board ? board.items.filter(i => !/^done$/i.test(i.status)).slice(0, 40).map(i => ({
      roles: i.roles.map(x => roleName(x)), name: i.name, status: i.status, due: i.due, people: i.people,
    })) : [];
    log(r.id, 'sys', `Gathered ${tasks.length} task(s), ${tickets.length} open ticket(s) and activity from ${repos.length} repo(s)`);

    const limits = limitsFor({ ...r, kind: 'report' });
    const run = runClaude({
      command: cfg.settings.claudeCommand,
      cwd: p.path,
      prompt: reportPrompt(p, { date: r.date, tasks, repos, tickets }),
      systemPrompt: reportSystemPrompt(p),
      mode: 'analyze',
      model: cfg.settings.reportModel || cfg.settings.model,
      addDirs: p.repos.map(x => x.path).filter(rp => path.relative(p.path, rp).startsWith('..')),
      permissionMode: cfg.settings.permissionMode,
      strictMcp: cfg.settings.strictMcp,
      inheritEnv: cfg.settings.inheritClaudeEnv,
      maxBudgetUsd: limits.taskBudgetUsd,
      tmpDir: TMP,
      onEvent: ev => { for (const l of describeEvent(ev, p.path)) if (l.kind !== 'say') log(r.id, l.kind, l.text); },
    });
    handle.kill = run.kill;
    if (handle.cancelled) run.kill();
    const unwatch = watchTimeout(r, limits, handle);
    const res = await run.done.finally(unwatch);
    if (res.budgetHit) handle.limitHit = 'budget';
    r.costUsd = res.costUsd;
    recordRun(r, res, cfg.settings.reportModel || cfg.settings.model, 'report');
    if (res.ok && !handle.limitHit) {
      Object.assign(r, parseReport(res.result), { status: 'done' });
    } else if (handle.limitHit && !handle.cancelled) {
      r.status = 'stopped';
      r.error = handle.limitHit === 'budget'
        ? `Stopped at the $${limits.taskBudgetUsd} cost limit. Run the stand-up again, or raise the limit.`
        : `Stopped at the ${limits.taskTimeoutMin}-minute time limit. Run the stand-up again, or raise the limit.`;
    } else {
      r.status = handle.cancelled ? 'cancelled' : 'failed';
      r.error = res.error;
    }
  } catch (e) {
    r.status = 'failed';
    r.error = e.message;
    log(r.id, 'err', e.message);
  }
  r.endedAt = Date.now();
  touchReport(r);
}

/* ---------------- daily stand-ups ---------------- */

function queueReports(projectId, trigger) {
  const made = [];
  for (const p of cfg.projects) {
    if (projectId && p.id !== projectId) continue;
    if (S.reports.some(r => r.projectId === p.id && (r.status === 'queued' || r.status === 'running'))) continue;
    const r = { id: newId('r'), projectId: p.id, date: todayStr(), trigger, status: 'queued', createdAt: Date.now(), queuedAt: Date.now() };
    S.reports.unshift(r);
    made.push(r);
    emit('report', r);
  }
  S.reports = S.reports.slice(0, 300);
  store.save();
  pump();
  return made;
}

function nextDaily() {
  const dr = cfg.settings.dailyReport;
  if (!dr.enabled) return null;
  const [h, m] = String(dr.at).split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  if (S.meta.lastDaily === todayStr()) d.setDate(d.getDate() + 1);
  while (dr.weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function checkDaily() {
  const dr = cfg.settings.dailyReport;
  if (!dr.enabled) return;
  const now = new Date();
  if (dr.weekdaysOnly && (now.getDay() === 0 || now.getDay() === 6)) return;
  const [h, m] = String(dr.at).split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < (h || 0) * 60 + (m || 0)) return;
  if (S.meta.lastDaily === todayStr(now)) return;
  S.meta.lastDaily = todayStr(now);
  console.log(`Daily stand-up: queuing reports for ${cfg.projects.length} project(s)`);
  queueReports(null, 'scheduled');
}
setInterval(checkDaily, 30000);
// Picks up runs held back by the daily limit once the day rolls over or the limit is raised.
setInterval(() => pump(), 60000);

/* ---------------- housekeeping ---------------- */

const ARCHIVE = path.join(DATA, 'archive');
const LOGS = path.join(DATA, 'logs');
let pruning = false;

/** Tasks and stand-ups housekeeping moved to data/archive/YYYY-MM.json, for the Costs page. */
function readArchive() {
  const out = { tasks: [], reports: [] };
  let files = [];
  try { files = fs.readdirSync(ARCHIVE).filter(f => /^\d{4}-\d{2}\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8'));
      out.tasks.push(...(d.tasks || []));
      out.reports.push(...(d.reports || []));
    } catch { /* a damaged archive file is skipped */ }
  }
  return out;
}

async function housekeepingPreview() {
  for (const p of cfg.projects) refreshRepos(p);
  const facts = await gatherFacts({ projects: cfg.projects, tasks: S.tasks, worktreeRoot: WT_DIR });
  const plan = planHousekeeping({ tasks: S.tasks, reports: S.reports, facts, settings: cfg.settings.housekeeping });
  return { plan, summary: planSummary(plan), empty: planIsEmpty(plan) };
}

async function runHousekeeping(trigger) {
  if (pruning) throw new Error('A cleanup is already running.');
  pruning = true;
  try {
    const { plan, summary } = await housekeepingPreview();
    const repoPath = t => {
      const p = project(t.projectId);
      const r = p && p.repos.find(x => x.name === t.repo);
      return r ? r.path : '';
    };
    const { done, skipped } = await runPlan(plan, {
      tasks: S.tasks,
      reports: S.reports,
      repoPathFor: repoPath,
      allRepoPaths: () => cfg.projects.flatMap(p => p.repos.filter(r => r.exists).map(r => r.path)),
      log,
      archiveDir: ARCHIVE,
      logDir: LOGS,
      removeJob: (kind, id) => {
        if (kind === 'task') { S.tasks = S.tasks.filter(t => t.id !== id); emit('task-removed', { id }); }
        else S.reports = S.reports.filter(r => r.id !== id);
      },
    });
    S.meta.lastPrune = { at: Date.now(), trigger, planned: summary, done, skipped };
    store.save();
    for (const t of S.tasks) if (t.cleaned) emit('task', t);
    console.log(`Housekeeping (${trigger}): ${summary}${skipped.length ? `; skipped ${skipped.length}` : ''}`);
    emit('reload', {});
    return S.meta.lastPrune;
  } finally {
    pruning = false;
  }
}

// Weekly cleanup, only when switched on in settings.housekeeping.auto.
setInterval(() => {
  const hk = cfg.settings.housekeeping;
  const last = (S.meta.lastPrune || {}).at || 0;
  if (!hk.auto || pruning || Date.now() - last < 7 * 864e5) return;
  runHousekeeping('weekly').catch(e => console.warn(`Housekeeping failed: ${e.message}`));
}, 3600e3);

/* ---------------- HTTP ---------------- */

const publicProject = p => ({
  id: p.id, name: p.name, path: p.path, stack: p.stack, context: p.context, exists: p.exists,
  repos: p.repos.map(r => ({ name: r.name, path: r.path, exists: r.exists })), roles: p.roles,
  handoffs: policyFor(p),
  activeRoles: p.activeRoles,
  allowCommands: p.allowCommands,
  knowledgeGraph: p.knowledgeGraph,
  graphs: Object.fromEntries(p.repos.map(r => [r.name, !!findGraph(r.path)])),
});

async function stateView() {
  return {
    settings: {
      model: cfg.settings.model, reportModel: cfg.settings.reportModel, maxConcurrent: cfg.settings.maxConcurrent,
      dailyReport: cfg.settings.dailyReport, workspacePath: cfg.settings.workspacePath, configFile: path.basename(cfg.file),
      limits: cfg.settings.limits,
      handoffs: cfg.settings.handoffs,
      ui: cfg.settings.ui,
    },
    spend: spendView(),
    etas: etas(),
    problems: cfg.problems,
    claude: await claudeFeatures(cfg.settings.claudeCommand),
    roles: ROLES.map(({ prompt, ...r }) => r),
    projects: cfg.projects.map(publicProject),
    tasks: S.tasks,
    reports: S.reports,
    nextDaily: nextDaily(),
    monday: monday.snapshot(),
    people: directory(cfg, monday.snapshot()).map(({ tickets, ...p }) => ({ ...p, ticketCount: tickets.length })),
    contacts: Object.fromEntries(cfg.projects.map(p => [p.id, Object.fromEntries(ROLES.map(r => [r.id, contactsFor(p.id, r.id, cfg, monday.snapshot()).map(x => x.name)]))])),
  };
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/* ---------------- handoffs and plans ---------------- */

const policyFor = p => handoffPolicy(cfg.settings.handoffs, p && p.handoffs);

/**
 * The repo a follow-on task works in: the one it names, else the previous task's, else the
 * role's usual repo, else the project's only repo. A read-only task may use the whole project.
 */
function followRepo(p, spec, prev) {
  const names = p.repos.map(r => r.name);
  // A repo that is named but not in the project is an error, never a silent switch to another
  // repo: a frontend change "in" the API repo only wastes a run.
  if (spec.repo && spec.repo !== '*' && !names.includes(spec.repo)) {
    throw new Error(`"${spec.title}" is for the ${spec.repo} repo, which is not in ${p.name} (${names.join(', ') || 'no repos'}). Clone it into the project folder, or assign the work yourself.`);
  }
  const pick = [spec.repo, prev && prev.repo !== '*' ? prev.repo : '', (p.roles[spec.role] || {}).repo, names.length === 1 ? names[0] : '']
    .find(n => n && names.includes(n));
  if (pick) return pick;
  if (spec.mode === 'analyze') return '*';
  throw new Error(`No repo for "${spec.title}": name one of ${names.join(', ') || '(none found)'}.`);
}

/** Start one proposed handoff: a new task that builds on its parent. */
function startHandoff(parent, h) {
  const p = project(parent.projectId);
  if ((parent.chainDepth || 0) + 1 > MAX_CHAIN_DEPTH) throw new Error(`This chain is already ${MAX_CHAIN_DEPTH} tasks deep. Assign the next step yourself.`);
  const child = createTaskFromSpec({
    projectId: parent.projectId, role: h.role, mode: h.mode, repo: followRepo(p, h, parent),
    title: h.title, details: [h.details, h.reason ? `Why now: ${h.reason}` : ''].filter(Boolean).join('\n\n'),
    parentId: parent.id, prevId: parent.id, dependsOn: [parent.id], chainDepth: (parent.chainDepth || 0) + 1, origin: 'handoff',
  });
  Object.assign(h, { status: 'started', taskId: child.id });
  log(parent.id, 'sys', `Handed off to the ${roleName(h.role)}: "${h.title}"`);
  return child;
}

/** Start every step of an Architect plan as linked tasks; returns the new tasks. */
function startPlan(planTask) {
  const p = project(planTask.projectId);
  const plan = planTask.plan;
  const idByKey = {};
  const made = [];
  const ids = [];
  const names = p.repos.map(r => r.name);
  const skipped = [];
  for (const s of plan.steps) {
    // Steps for a repo the project does not have are shown in the plan but never started.
    if (s.missingRepo || (s.repo && s.repo !== '*' && !names.includes(s.repo))) {
      s.missingRepo = true;
      skipped.push(s.title);
      ids.push(null);
      continue;
    }
    const deps = s.dependsOn.map(k => idByKey[k]).filter(Boolean);
    const depTasks = deps.map(taskById);
    // Build on the latest dependency that changes the same repo; else read the latest one.
    const repo = followRepo(p, s, depTasks[depTasks.length - 1] || null);
    const prev = [...depTasks].reverse().find(d => d.mode === 'change' && d.repo === repo) || depTasks[depTasks.length - 1] || planTask;
    const child = createTaskFromSpec({
      projectId: planTask.projectId, role: s.role, mode: s.mode, repo, title: s.title, details: s.details,
      parentId: planTask.id, prevId: prev.id, dependsOn: deps.length ? deps : [planTask.id],
      chainDepth: (planTask.chainDepth || 0) + 1, origin: 'plan', planKey: s.key,
    }, { deferPump: true });
    idByKey[s.key] = child.id;
    made.push(child);
    ids.push(child.id);
  }
  if (!made.length) throw new Error('Every step of this plan is for a repo that is not in the project, so nothing was started.');
  Object.assign(plan, { status: 'started', taskIds: ids });
  log(planTask.id, 'sys', `Plan started: ${made.length} linked task(s).`);
  if (skipped.length) log(planTask.id, 'warn', `Not started, because their repo is not in ${p.name}: ${skipped.map(x => `"${x}"`).join(', ')}.`);
  pump();
  return made;
}

/** After a task is done: read its handoffs or plan, and start them if the policy says so. */
function takeNextSteps(t, p, result) {
  const policy = policyFor(p);
  const roleIds = (p && p.activeRoles && p.activeRoles.length) ? p.activeRoles : ROLES.map(r => r.id);
  if (t.planTask) {
    const steps = parsePlan(result, { roleIds, repoNames: p ? p.repos.map(r => r.name) : null });
    if (!steps.length) { log(t.id, 'warn', 'The plan had no usable steps.'); return; }
    t.plan = { steps, status: 'proposed' };
    if (policy === 'auto') {
      try { startPlan(t); } catch (e) { t.plan.status = 'proposed'; log(t.id, 'warn', `Could not start the plan: ${e.message}`); }
    }
    return;
  }
  if (policy === 'off' || t.origin === 'plan') return;
  const found = parseHandoffs(result, { fromRole: t.role, roleIds });
  const have = new Set((t.handoffs || []).map(h => `${h.role}:${h.title.toLowerCase()}`));
  for (const h of found) {
    if (have.has(`${h.role}:${h.title.toLowerCase()}`)) continue;
    (t.handoffs = t.handoffs || []).push({ id: newId('h'), ...h, status: 'proposed' });
  }
  if (policy === 'auto') {
    for (const h of t.handoffs || []) {
      if (h.status !== 'proposed') continue;
      try { startHandoff(t, h); } catch (e) { h.status = 'failed'; h.error = e.message; log(t.id, 'warn', e.message); }
    }
  }
}

async function createTask(b) {
  const p = project(b.projectId);
  if (!p) throw new Error('Unknown project.');
  if (!roleById(b.role)) throw new Error('Unknown role.');
  const plan = b.plan === true || b.plan === 'on' || b.plan === 'true';
  if (!plan && !p.activeRoles.includes(b.role)) throw new Error(`${p.name} has no ${roleName(b.role)}. Turn the role on in the project's settings first.`);
  const kind = plan ? '' : roleKind(b.role);
  // The Code Reviewer only reads; the Conflict Fixer always changes (it commits a merge).
  const mode = plan || kind === 'review' ? 'analyze' : kind === 'conflicts' ? 'change' : b.mode === 'analyze' ? 'analyze' : 'change';
  let title = String(b.title || '').trim();
  refreshRepos(p);
  const special = {};
  if (kind === 'review' || kind === 'conflicts') {
    const repo = p.repos.find(r => r.name === String(b.repo || '').trim()) || (p.repos.length === 1 ? p.repos[0] : null);
    if (!repo) throw new Error('Pick the repo that holds the branch.');
    if (b.fetch !== false) await G.fetchOrigin(repo.path);
    const need = async (v, what) => {
      const ref = G.cleanRef(v);
      if (!ref) throw new Error(`Give the ${what}.`);
      const found = await G.resolveRef(repo.path, ref);
      if (!found) throw new Error(`There is no branch "${ref}" in ${repo.name}.`);
      return found;
    };
    if (kind === 'review') {
      const branch = await need(b.reviewBranch, 'branch to review');
      const base = b.reviewBase ? await need(b.reviewBase, 'base branch') : (await G.resolveRef(repo.path, 'main')) || (await G.resolveRef(repo.path, 'master'));
      if (!base) throw new Error('Give the base branch to compare with.');
      const pr = String(b.prNumber || '').trim().replace(/^#/, '');
      const prNumber = /^\d{1,7}$/.test(pr) ? pr : '';
      special.review = { branch, base, prNumber };
      if (!title) title = `Review ${prNumber ? `PR #${prNumber} (${branch})` : branch}`;
    } else {
      special.base = await need(b.fixBranch || b.base, 'branch to fix');
      special.mergeTarget = await need(b.mergeTarget, 'branch to merge in');
      if (special.base === special.mergeTarget) throw new Error('The branch to fix and the branch to merge in are the same.');
      if (!title) title = `Merge ${special.mergeTarget} into ${special.base} and fix the conflicts`;
    }
    b.repo = repo.name;
  }
  if (!title) throw new Error('Give the task a title.');
  let repoName = String(b.repo || '').trim();
  if (plan && !repoName) repoName = '*';
  if (repoName === '*' && mode === 'change') throw new Error('Pick one repo for a task that changes code.');
  if (repoName !== '*' && !p.repos.some(r => r.name === repoName)) {
    if (p.repos.length === 1) repoName = p.repos[0].name;
    else throw new Error(p.repos.length ? `Unknown repo "${repoName}".` : `No git repos found in ${p.path}.`);
  }
  let details = String(b.details || '').slice(0, 8000);
  let ticket = null;
  if (b.ticketId) {
    const d = await monday.details(p.id, b.ticketId);
    ticket = { itemId: d.id, name: d.name, url: d.url, status: d.status };
    const cols = Object.entries(d.columns || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
    const ups = (d.updates || []).map(u => `- ${u.by || 'someone'}: ${u.text.replace(/\s+/g, ' ')}`).join('\n');
    details = `monday.com ticket "${d.name}"${d.url ? ` (${d.url})` : ''}\n${cols}${ups ? `\n\nLatest updates on the ticket:\n${ups}` : ''}${details ? `\n\nFrom the owner:\n${details}` : ''}`;
  }
  return createTaskFromSpec({
    projectId: p.id, role: plan ? 'architect' : b.role, mode, repo: repoName, base: special.base || G.cleanRef(b.base),
    title, details, model: String(b.model || ''), ticket,
    review: special.review || null, mergeTarget: special.mergeTarget || '',
    // Per-task overrides from the Assign dialog; blank fields fall back to role/project/app limits.
    limits: cleanLimits({ taskBudgetUsd: b.budgetUsd, taskTimeoutMin: b.timeoutMin }),
    planTask: plan, origin: 'owner',
  });
}

/** Queue a task from a validated spec: from the owner, a handoff, or a plan step. */
function createTaskFromSpec(spec, { deferPump = false } = {}) {
  const t = {
    id: newId('t'), projectId: spec.projectId, role: spec.role, mode: spec.mode, repo: spec.repo, base: spec.base || '',
    title: String(spec.title).slice(0, 200), details: String(spec.details || '').slice(0, 8000), model: spec.model || '',
    ticket: spec.ticket || null, limits: spec.limits || {},
    planTask: !!spec.planTask, parentId: spec.parentId || '', prevId: spec.prevId || '', dependsOn: spec.dependsOn || [],
    chainDepth: spec.chainDepth || 0, origin: spec.origin || 'owner', planKey: spec.planKey || '',
    review: spec.review || null, mergeTarget: spec.mergeTarget || '',
    status: 'queued', createdAt: Date.now(), queuedAt: Date.now(), costUsd: 0, turns: 0, history: [],
  };
  // Kept so the cost page can later compare what we expected with what happened.
  t.estimate = estimateFor({ projectId: t.projectId, role: t.role, mode: t.mode, model: jobModel(t), text: taskText(t) });
  S.tasks.unshift(t);
  touchTask(t);
  if (!deferPump) pump();
  return t;
}

async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (m === 'GET' && url.pathname === '/api/state') return send(res, 200, await stateView());

  if (m === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && parts[1] === 'log' && parts[2]) return send(res, 200, store.readLog(parts[2]));

  // GET ?project&role&mode&model gives the default limits and a role-level estimate; POST with the
  // typed title and details (the dialog's Estimate ETA button) estimates that particular task.
  if ((m === 'GET' || m === 'POST') && url.pathname === '/api/estimate') {
    const q = url.searchParams;
    const b = m === 'POST' ? await readBody(req) : {};
    const p = project(b.projectId || q.get('project'));
    if (!p) return send(res, 404, { error: 'Unknown project.' });
    const role = b.role || q.get('role');
    const mode = (b.mode || q.get('mode')) === 'analyze' ? 'analyze' : 'change';
    const model = b.model || q.get('model') || (p.roles[role] || {}).model || cfg.settings.model;
    const text = `${String(b.title || '').slice(0, 200)}\n${String(b.details || '').slice(0, 8000)}`.trim();
    const est = estimateFor({ projectId: p.id, role, mode, model, text });
    const limits = resolveLimits(cfg.settings.limits, p.limits, (p.roles[role] || {}).limits);
    // When would a task assigned now start and finish? Simulate it at the back of the queue.
    const probe = { id: '__probe', projectId: p.id, role, mode, model, status: 'queued', queuedAt: Date.now(), estimate: est };
    S.tasks.push(probe);
    let eta;
    try { eta = etas().__probe || null; } finally { S.tasks.pop(); }
    return send(res, 200, { estimate: est, limits, model, eta, spend: { today: todaysSpend(), paused: dailyLimitReached() } });
  }

  if (m === 'GET' && url.pathname === '/api/branches') {
    const p = project(url.searchParams.get('project'));
    const repo = p && p.repos.find(r => r.name === url.searchParams.get('repo'));
    if (!repo) return send(res, 404, { error: 'Unknown repo.' });
    return send(res, 200, { current: await G.currentBranch(repo.path), branches: await G.localBranches(repo.path), remote: await G.remoteBranches(repo.path) });
  }

  if (m === 'POST' && url.pathname === '/api/tasks') return send(res, 200, await createTask(await readBody(req)));

  if (m === 'GET' && url.pathname === '/api/people/search') return send(res, 200, searchPeople(url.searchParams.get('q') || '', cfg, monday.snapshot()));

  if (m === 'GET' && url.pathname === '/api/monday') {
    if (url.searchParams.get('refresh')) await refreshMonday(url.searchParams.get('project') || undefined);
    return send(res, 200, monday.snapshot());
  }

  if (m === 'POST' && (url.pathname === '/api/monday/assign' || url.pathname === '/api/monday/create')) {
    const b = await readBody(req);
    if (!project(b.projectId)) return send(res, 400, { error: 'Unknown project.' });
    const person = b.person ? directory(cfg, monday.snapshot()).find(x => x.name === b.person) : null;
    if (b.person && !person) return send(res, 400, { error: `${b.person} is not in the people list.` });
    let out;
    if (url.pathname.endsWith('/assign')) {
      if (!person) return send(res, 400, { error: 'Pick who to assign it to.' });
      out = await monday.assign(b.projectId, b.itemId, person);
    } else {
      const name = String(b.name || '').trim();
      if (!name) return send(res, 400, { error: 'Give the ticket a name.' });
      out = await monday.createItem(b.projectId, { name: name.slice(0, 250), description: String(b.description || '').slice(0, 4000), role: roleById(b.role) ? b.role : '', person });
    }
    emit('monday', monday.snapshot());
    return send(res, 200, out);
  }

  if (parts[1] === 'tasks' && parts[2]) {
    const t = S.tasks.find(x => x.id === parts[2]);
    if (!t) return send(res, 404, { error: 'No such task.' });
    const action = parts[3];
    if (m === 'POST' && action === 'followup') {
      const { text, budgetUsd, timeoutMin } = await readBody(req);
      if (!String(text || '').trim()) return send(res, 400, { error: 'Write the follow-up first.' });
      if (t.status === 'running' || t.status === 'queued') return send(res, 409, { error: 'The agent is still on this task. Wait for it to finish.' });
      if (t.cleaned) return send(res, 409, { error: 'This task\'s worktree was cleaned up. Assign a new task instead.' });
      // Continuing after a limit: new limits apply to this and later runs of the task. The run
      // resumes the same Claude session on the same branch, so no work is lost or redone.
      const raised = cleanLimits({ taskBudgetUsd: budgetUsd, taskTimeoutMin: timeoutMin });
      if (Object.keys(raised).length) {
        t.limits = { ...(t.limits || {}), ...raised };
        log(t.id, 'sys', `Limits for this task are now ${[raised.taskBudgetUsd !== undefined ? `$${raised.taskBudgetUsd} per run` : '', raised.taskTimeoutMin !== undefined ? `${raised.taskTimeoutMin} min per run` : ''].filter(Boolean).join(' and ')}.`);
      }
      t.pendingFollowup = String(text).trim().slice(0, 8000);
      t.status = 'queued';
      t.queuedAt = Date.now();
      touchTask(t);
      pump();
      return send(res, 200, t);
    }
    // /api/tasks/:id/handoffs/:handoffId/start|dismiss
    if (m === 'POST' && action === 'handoffs' && parts[4] && (parts[5] === 'start' || parts[5] === 'dismiss')) {
      const h = (t.handoffs || []).find(x => x.id === parts[4]);
      if (!h) return send(res, 404, { error: 'No such handoff.' });
      if (h.status !== 'proposed' && h.status !== 'failed') return send(res, 409, { error: `This handoff was already ${h.status}.` });
      if (parts[5] === 'dismiss') { h.status = 'dismissed'; touchTask(t); return send(res, 200, t); }
      const child = startHandoff(t, h);
      touchTask(t);
      return send(res, 200, { task: t, child });
    }
    // /api/tasks/:id/review/post {prNumber, event}: post the Code Reviewer's findings on the
    // pull request with the GitHub CLI. Only ever on the owner's click.
    if (m === 'POST' && action === 'review' && parts[4] === 'post') {
      const b = await readBody(req);
      if (!t.review || !t.review.result) return send(res, 400, { error: 'This task has no review to post.' });
      const p = project(t.projectId);
      const repo = p && p.repos.find(r => r.name === t.repo);
      if (!repo) return send(res, 400, { error: `Repo "${t.repo}" was not found.` });
      const pr = String(b.prNumber || t.review.prNumber || '').trim().replace(/^#/, '');
      const event = ['comment', 'approve', 'request_changes'].includes(b.event) ? b.event : 'comment';
      try {
        const out = await postReview({
          repoPath: repo.path, prNumber: pr, event,
          body: reviewMarkdown(t.review.result, { branch: t.review.branch, base: t.review.base }),
        });
        t.review.prNumber = pr;
        t.review.posted = { at: Date.now(), event, url: out.url || '' };
        log(t.id, 'sys', `Review posted on pull request #${pr}${out.url ? ` (${out.url})` : ''}.`);
        touchTask(t);
        return send(res, 200, t);
      } catch (e) {
        const msg = /not found|ENOENT/i.test(e.message) && !/pull request/i.test(e.message)
          ? 'The GitHub CLI (gh) was not found. Install it and run gh auth login.'
          : e.message;
        return send(res, 400, { error: `Could not post the review: ${msg}` });
      }
    }
    // /api/tasks/:id/plan/start|dismiss
    if (m === 'POST' && action === 'plan' && (parts[4] === 'start' || parts[4] === 'dismiss')) {
      if (!t.plan) return send(res, 404, { error: 'This task has no plan.' });
      if (t.plan.status !== 'proposed') return send(res, 409, { error: `This plan was already ${t.plan.status}.` });
      if (parts[4] === 'dismiss') { t.plan.status = 'dismissed'; touchTask(t); return send(res, 200, t); }
      const made = startPlan(t);
      touchTask(t);
      return send(res, 200, { task: t, tasks: made });
    }
    if (m === 'POST' && action === 'cancel') {
      if (t.status === 'queued' || t.status === 'blocked') { t.status = 'cancelled'; t.pendingFollowup = ''; touchTask(t); }
      const h = running.get(t.id);
      if (h) { h.cancelled = true; if (h.kill) h.kill(); }
      pump(); // tasks that depend on this one become blocked
      return send(res, 200, t);
    }
    if (m === 'POST' && action === 'monday-update') {
      if (!t.ticket) return send(res, 400, { error: 'This task is not linked to a monday.com ticket.' });
      if (!t.result) return send(res, 400, { error: 'There is no report to post yet.' });
      const lines = [`<b>${roleName(t.role)} (Dev Crew)</b>: ${t.status === 'done' ? 'finished' : t.status}`, '', (t.summary || '').replace(/\n/g, '<br>')];
      if (t.branch) lines.push('', `Branch: ${t.branch}${t.git ? ` (${t.git.commits.length} commit(s), ${t.git.shortstat || 'no changes'})` : ''}. Not pushed yet; waiting for review.`);
      const r = await monday.postUpdate(t.projectId, t.ticket.itemId, lines.join('<br>'));
      t.ticket.postedAt = Date.now();
      log(t.id, 'sys', r.demo ? 'Report posted to the demo ticket.' : 'Report posted to the monday.com ticket.');
      touchTask(t);
      return send(res, 200, t);
    }
    if (m === 'POST' && action === 'cleanup') {
      if (running.has(t.id) || t.status === 'queued') return send(res, 409, { error: 'Cancel the task first.' });
      if (t.worktree && !t.cleaned) {
        const p = project(t.projectId);
        const repo = p && p.repos.find(r => r.name === t.repo);
        if (repo) await G.removeWorktree(repo.path, t.worktree);
        t.cleaned = true;
        log(t.id, 'sys', `Worktree removed. Branch ${t.branch} is kept in the repo.`);
        touchTask(t);
      }
      return send(res, 200, t);
    }
    if (m === 'DELETE' && !action) {
      if (running.has(t.id) || t.status === 'queued') return send(res, 409, { error: 'Cancel the task first.' });
      if (t.worktree && !t.cleaned) {
        const p = project(t.projectId);
        const repo = p && p.repos.find(r => r.name === t.repo);
        if (repo) await G.removeWorktree(repo.path, t.worktree);
      }
      S.tasks = S.tasks.filter(x => x !== t);
      store.save();
      emit('task-removed', { id: t.id });
      pump(); // tasks that depend on this one become blocked
      return send(res, 200, { ok: true });
    }
  }

  if (m === 'POST' && url.pathname === '/api/reports/run') {
    const { projectId } = await readBody(req);
    return send(res, 200, queueReports(projectId || null, 'manual'));
  }

  if (m === 'POST' && parts[1] === 'reports' && parts[3] === 'cancel') {
    const r = S.reports.find(x => x.id === parts[2]);
    if (!r) return send(res, 404, { error: 'No such report.' });
    if (r.status === 'queued') { r.status = 'cancelled'; touchReport(r); }
    const h = running.get(r.id);
    if (h) { h.cancelled = true; if (h.kill) h.kill(); }
    return send(res, 200, r);
  }

  if (m === 'GET' && url.pathname === '/api/housekeeping') {
    const preview = await housekeepingPreview();
    return send(res, 200, { ...preview, settings: cfg.settings.housekeeping, last: S.meta.lastPrune || null, running: pruning });
  }

  if (m === 'POST' && url.pathname === '/api/housekeeping/run') {
    return send(res, 200, await runHousekeeping('manual'));
  }

  if (m === 'POST' && url.pathname === '/api/reload') {
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true, problems: cfg.problems });
  }

  /* ---- editing the config from the dashboard ---- */

  // Folders to pick a project from: the workspace by default, with which ones hold git repos.
  if (m === 'GET' && url.pathname === '/api/browse') {
    const dir = path.resolve(cfg.settings.workspacePath, url.searchParams.get('dir') || '.');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 404, { error: `Folder not found: ${dir}` });
    const used = new Map(cfg.projects.map(p => [canonical(p.path), p.name]));
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .slice(0, 300)
      .map(d => {
        const full = path.join(dir, d.name);
        return { name: d.name, path: full, repos: findRepos(full).length, usedBy: used.get(canonical(full)) || '' };
      });
    const parent = path.dirname(dir);
    return send(res, 200, { dir, parent: parent !== dir ? parent : '', workspace: cfg.settings.workspacePath, entries });
  }

  if (m === 'POST' && url.pathname === '/api/detect') {
    const { folder } = await readBody(req);
    const dir = path.resolve(cfg.settings.workspacePath, String(folder || ''));
    if (!folder || !fs.existsSync(dir)) return send(res, 404, { error: `Folder not found: ${dir}` });
    const found = detectProject(dir);
    const taken = new Set(cfg.projects.map(p => p.id));
    let id = found.id;
    for (let n = 2; taken.has(id); n++) id = `${found.id}-${n}`;
    return send(res, 200, { ...found, id, repos: found.repos.map(r => ({ name: r.name, stack: r.stack })) });
  }

  // The raw project as written in the config, for the editor.
  if (m === 'GET' && parts[1] === 'projects' && parts[2] && parts[3] === 'config') {
    const rawP = (readRaw().projects || []).find(p => p.id === parts[2]);
    if (!rawP) return send(res, 404, { error: 'This project is not in crew.config.local.json.' });
    const p = project(parts[2]);
    return send(res, 200, { project: rawP, folderPath: p ? p.path : '', repos: p ? p.repos.map(r => r.name) : [] });
  }

  if (m === 'PUT' && parts[1] === 'projects' && parts[2] && !parts[3]) {
    const form = await readBody(req);
    const raw = readRaw();
    const oldId = parts[2] === '_new' ? null : parts[2];
    const existing = oldId ? (raw.projects || []).find(p => p.id === oldId) || {} : {};
    if (oldId && oldId !== form.id && S.tasks.some(t => t.projectId === oldId && ['queued', 'running', 'blocked'].includes(t.status))) {
      return send(res, 409, { error: 'Finish or cancel this project\'s active tasks before changing its id.' });
    }
    const proj = projectFromForm(form, existing, cfg.settings.workspacePath);
    writeRaw(upsertProject(raw, proj, oldId || proj.id));
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true, id: proj.id });
  }

  // POST /api/projects/:id/allow {rule}: add a command an agent was refused to the project's
  // allowed commands (change tasks only; the always-refused list still wins).
  if (m === 'POST' && parts[1] === 'projects' && parts[2] && parts[3] === 'allow') {
    const { rule } = await readBody(req);
    const r = String(rule || '').trim().replace(/\s+/g, ' ');
    const problem = ruleProblem(r);
    if (problem) return send(res, 400, { error: problem });
    const raw = readRaw();
    const rawP = (raw.projects || []).find(p => p.id === parts[2]);
    if (!rawP) return send(res, 404, { error: 'This project is not in crew.config.local.json.' });
    const list = Array.isArray(rawP.allowCommands) ? rawP.allowCommands : [];
    if (!list.includes(r)) rawP.allowCommands = [...list, r];
    writeRaw(raw);
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true, allowCommands: rawP.allowCommands });
  }

  if (m === 'DELETE' && parts[1] === 'projects' && parts[2] && !parts[3]) {
    if (S.tasks.some(t => t.projectId === parts[2] && ['queued', 'running', 'blocked'].includes(t.status))) {
      return send(res, 409, { error: 'Finish or cancel this project\'s active tasks first.' });
    }
    writeRaw(removeProject(readRaw(), parts[2]));
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true });
  }

  // The Costs page: run data from live and archived tasks and stand-ups.
  if (m === 'GET' && (url.pathname === '/api/analytics' || url.pathname === '/api/analytics.csv')) {
    const q = url.searchParams;
    const day = s => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : undefined);
    const filters = { from: day(q.get('from')), to: day(q.get('to')), projectId: q.get('project') || undefined, role: q.get('role') || undefined, model: q.get('model') || undefined };
    const archived = readArchive();
    // knowledge-graph trial runs are real spend too
    const trials = [];
    try {
      const dir = path.join(DATA, 'graph-trial');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json')) : []) {
        try { trials.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* a half-written file */ }
      }
    } catch { /* no trials */ }
    const idOf = name => (cfg.projects.find(p => p.name === name || p.id === name) || {}).id || name;
    const tasks = [...S.tasks, ...archived.tasks, ...trialJobs(trials, idOf)];
    const rows = collectRuns({ tasks, reports: [...S.reports, ...archived.reports] });
    const projectName = id => (project(id) || {}).name || id;
    if (url.pathname.endsWith('.csv')) {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="dev-crew-runs-${filters.from || 'all'}-to-${filters.to || dayKey(Date.now())}.csv"`,
        'cache-control': 'no-store',
      });
      return res.end(runsCsv(filterRows(rows, filters), projectName));
    }
    const summary = summarize(rows, { ...filters, tasks, projectName, dailyLimit: cfg.settings.limits.dailyBudgetUsd });
    const all = collectRuns({ tasks, reports: [] });
    return send(res, 200, {
      ...summary,
      options: {
        projects: cfg.projects.map(p => ({ id: p.id, name: p.name })),
        roles: [...new Set([...ROLES.map(r => r.id), 'stand-up', ...(trials.length ? ['graph-trial'] : [])])],
        models: [...new Set(rows.map(r => r.model))].sort(),
        firstDay: rows.length ? rows[0].day : dayKey(Date.now()),
        hasArchive: archived.tasks.length + archived.reports.length > 0,
        totalRuns: all.length,
      },
    });
  }

  // The Settings page. Secrets are never sent to the browser (maskSettings).
  if (m === 'GET' && url.pathname === '/api/settings') {
    const show = rules => [...new Set(rules.map(r => r.replace(/^(Bash|PowerShell)\((.*):\*\)$/, '$2')))];
    const change = toolPolicy('change');
    const analyze = toolPolicy('analyze');
    return send(res, 200, {
      settings: maskSettings(readRaw().settings || {}),
      effective: {
        model: cfg.settings.model, reportModel: cfg.settings.reportModel, maxConcurrent: cfg.settings.maxConcurrent,
        limits: cfg.settings.limits, handoffs: cfg.settings.handoffs, dailyReport: cfg.settings.dailyReport,
        housekeeping: cfg.settings.housekeeping, ui: cfg.settings.ui, claudeCommand: cfg.settings.claudeCommand,
        inheritClaudeEnv: cfg.settings.inheritClaudeEnv, workspacePath: cfg.settings.workspacePath, port: cfg.settings.port,
        configFile: path.basename(cfg.file),
      },
      mondayTokenFromEnv: !!process.env.MONDAY_API_TOKEN,
      claude: await claudeFeatures(cfg.settings.claudeCommand),
      permissions: {
        change: show(change.allowed), analyze: show(analyze.allowed), denied: show(change.disallowed),
        projects: cfg.projects.map(p => ({ name: p.name, extra: p.allowCommands })),
      },
    });
  }

  if (m === 'PUT' && url.pathname === '/api/settings') {
    const form = await readBody(req);
    const raw = readRaw();
    const { settings, errors } = settingsFromForm(form, raw.settings || {});
    if (errors.length) return send(res, 400, { error: errors.join(' ') });
    const before = cfg.settings.claudeCommand;
    writeRaw({ ...raw, settings });
    cfg = loadConfig();
    if (cfg.settings.claudeCommand !== before) resetClaude();
    pump(); // a higher "agents at a time" or daily limit can start waiting work now
    emit('reload', {});
    return send(res, 200, { ok: true, restartNeeded: false });
  }

  if (m === 'GET' && url.pathname === '/api/people') return send(res, 200, { people: readRaw().people || [] });

  if (m === 'PUT' && url.pathname === '/api/people') {
    const { people } = await readBody(req);
    writeRaw({ ...readRaw(), people: peopleFromForm(people) });
    cfg = loadConfig();
    emit('reload', {});
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const refused = checkRequest({ method: req.method, pathname: url.pathname, headers: req.headers, port: cfg.settings.port });
  if (refused) return send(res, refused.code, { error: refused.error });
  try {
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': (TYPES[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

const shutdown = () => {
  for (const h of running.values()) if (h.kill) h.kill();
  store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(cfg.settings.port, '127.0.0.1', async () => {
  const f = await claudeFeatures(cfg.settings.claudeCommand);
  console.log(`\nDev Crew → http://localhost:${cfg.settings.port}`);
  console.log(`  config:    ${cfg.file}`);
  console.log(`  workspace: ${cfg.settings.workspacePath}`);
  for (const p of cfg.projects) {
    console.log(`  · ${p.name.padEnd(22)} ${p.exists ? `${p.repos.length} repo(s): ${p.repos.map(r => r.name).join(', ') || '—'}` : `folder missing (${p.path})`}`);
  }
  for (const pr of cfg.problems) console.log(`  ! ${pr}`);
  console.log(`  claude:    ${f.found ? f.version : 'NOT FOUND — install Claude Code and log in'}`);
  const dr = cfg.settings.dailyReport;
  console.log(`  stand-up:  ${dr.enabled ? `daily at ${dr.at}${dr.weekdaysOnly ? ' on weekdays' : ''}` : 'off'} · ${cfg.settings.maxConcurrent} agent(s) at a time\n`);
  pump();
  setTimeout(checkDaily, 5000);
  refreshMonday().then(() => {
    const snap = monday.snapshot();
    console.log(`  monday:    ${snap.connected ? `connected · ${Object.values(snap.boards).filter(b => !b.demo).length} board(s)` : 'not connected (demo tickets) · set MONDAY_API_TOKEN to connect'}`);
  }).catch(e => console.warn(e.message));
});
