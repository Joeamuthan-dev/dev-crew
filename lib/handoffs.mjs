// Handoffs and plans: how one crew member's finished work turns into the next member's task.
//  - A task report may end with a "## Handoff" section: who should act next, and why.
//  - An Architect "plan" task returns a "## Plan" section: linked steps with dependencies.
// Everything here is pure (no I/O) so it can be unit tested.

export const HANDOFF_POLICIES = ['ask', 'auto', 'off'];
export const MAX_HANDOFFS_PER_TASK = 3;
export const MAX_CHAIN_DEPTH = 5;
export const MAX_PLAN_STEPS = 8;

/** The JSON array in the fenced ```json block under a "## <heading>" section, or null. */
function sectionJson(text, heading) {
  const re = new RegExp(`##\\s*${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const sec = re.exec(String(text || ''));
  if (!sec) return null;
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(sec[1]);
  if (!block) return null;
  try {
    const v = JSON.parse(block[1]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const modeOf = m => (m === 'analyze' ? 'analyze' : 'change');

/**
 * Handoffs from a task report. Drops unknown roles and handoffs back to the role that wrote the
 * report (a role cannot hand work to itself), and keeps at most MAX_HANDOFFS_PER_TASK.
 */
export function parseHandoffs(text, { fromRole, roleIds }) {
  const list = sectionJson(text, 'Handoff') || [];
  const seen = new Set();
  const out = [];
  for (const h of list) {
    if (!h || !roleIds.includes(h.role) || h.role === fromRole) continue;
    const title = str(h.title, 200);
    if (!title) continue;
    const key = `${h.role}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ role: h.role, mode: modeOf(h.mode), title, details: str(h.details, 4000), reason: str(h.reason, 500), repo: str(h.repo, 200) });
    if (out.length >= MAX_HANDOFFS_PER_TASK) break;
  }
  return out;
}

/**
 * Steps from an Architect plan. Each step has a short key; dependsOn lists earlier keys. Unknown
 * roles, unknown or forward dependencies and cycles are dropped; at most MAX_PLAN_STEPS.
 */
/**
 * The steps of an Architect plan. With repoNames, a step that names a repo the project does not
 * have is kept but marked missingRepo: it is shown in the plan and never started.
 */
export function parsePlan(text, { roleIds, repoNames = null }) {
  const list = sectionJson(text, 'Plan') || [];
  const steps = [];
  const keys = new Set();
  for (const [i, s] of list.entries()) {
    if (steps.length >= MAX_PLAN_STEPS) break;
    if (!s || !roleIds.includes(s.role)) continue;
    const title = str(s.title, 200);
    if (!title) continue;
    let key = str(s.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, '') || `s${i + 1}`;
    while (keys.has(key)) key += '_';
    // Only dependencies on steps that come earlier: this also rules out cycles.
    const deps = (Array.isArray(s.dependsOn) ? s.dependsOn : [])
      .map(d => String(d).toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      .filter(d => keys.has(d));
    keys.add(key);
    const repo = str(s.repo, 200);
    const missingRepo = !!(repoNames && repo && repo !== '*' && !repoNames.includes(repo));
    steps.push({ key, role: s.role, mode: modeOf(s.mode), title, details: str(s.details, 4000), repo, dependsOn: [...new Set(deps)], ...(missingRepo ? { missingRepo: true } : {}) });
  }
  return steps;
}

/**
 * Whether a task may start, given the tasks it depends on:
 *  'ready'   every dependency is done
 *  'waiting' some are still queued, running or held
 *  'blocked' one failed, was cancelled, stopped at a limit, or was deleted
 */
export function depsState(task, byId) {
  const deps = task.dependsOn || [];
  let waiting = false;
  for (const id of deps) {
    const d = byId(id);
    if (!d) return { state: 'blocked', reason: 'A task it depends on was deleted.' };
    if (d.status === 'done') continue;
    if (['failed', 'cancelled', 'stopped', 'blocked'].includes(d.status)) {
      const why = { failed: 'failed', cancelled: 'was cancelled', stopped: 'stopped at a limit', blocked: 'is blocked' }[d.status];
      return { state: 'blocked', reason: `Waiting on "${d.title}", which ${why}.`, by: d.id };
    }
    waiting = true;
  }
  return { state: waiting ? 'waiting' : 'ready' };
}

/** Where a follow-on task should start: the previous task's branch when it changed the same repo. */
export function startPoint(prev, mode, repo) {
  if (!prev) return { base: '', readFrom: '' };
  const sameRepo = prev.repo === repo;
  if (mode === 'change') return { base: sameRepo && prev.mode === 'change' && prev.branch ? prev.branch : '', readFrom: '' };
  // A read-only follow-on (review, QA investigation) reads the previous task's worktree, so it
  // sees the new work before anyone merges it.
  return { base: '', readFrom: sameRepo && prev.worktree && !prev.cleaned ? prev.worktree : '' };
}

/** Effective handoff policy: project setting, then app setting, then 'ask'. */
export function handoffPolicy(appSetting, projectSetting) {
  if (HANDOFF_POLICIES.includes(projectSetting)) return projectSetting;
  if (HANDOFF_POLICIES.includes(appSetting)) return appSetting;
  return 'ask';
}
