// Housekeeping: decides what can be cleaned up (worktrees, merged agent branches, old tasks and
// logs) without ever losing work. The server gathers the facts from git and the disk; this file
// only decides, so the rules can be unit tested. Nothing here touches the disk.
//
// Safety rules:
//  - never touch anything a queued, running or blocked task still builds on;
//  - never remove a worktree with uncommitted changes;
//  - only delete an agent branch whose commits are already in the branch it started from
//    (locally or on origin), so deleting it loses nothing; unmerged branches are kept and listed;
//  - old tasks are archived to data/archive, not deleted.

export const DEFAULT_HOUSEKEEPING = {
  worktreeDays: 7,  // remove a finished task's worktree after this many days (the branch stays)
  taskDays: 30,     // archive finished tasks and stand-ups older than this
  auto: false,      // run the cleanup by itself once a week
};

const DAY = 864e5;
const ACTIVE = new Set(['queued', 'running', 'blocked']);
const FINISHED = new Set(['done', 'failed', 'cancelled', 'stopped']);

export function cleanHousekeeping(raw) {
  const out = { ...DEFAULT_HOUSEKEEPING };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['worktreeDays', 'taskDays']) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (typeof raw.auto === 'boolean') out.auto = raw.auto;
  return out;
}

/** Ids of tasks that a queued, running or blocked task still builds on or waits for. */
export function neededTaskIds(tasks) {
  const needed = new Set();
  for (const t of tasks) {
    if (!ACTIVE.has(t.status)) continue;
    if (t.prevId) needed.add(t.prevId);
    for (const d of t.dependsOn || []) needed.add(d);
  }
  return needed;
}

/**
 * What to clean up.
 * facts.worktrees: { [taskId]: { exists, dirty, sizeBytes } } for tasks with a live worktree
 * facts.branches:  [{ repo, repoPath, name, merged, mergedInto, commits }] local agent/* branches
 * facts.orphanDirs: [{ path, sizeBytes }] folders under data/worktrees that no task owns
 */
export function planHousekeeping({ tasks, reports = [], facts, settings, now = Date.now() }) {
  const s = cleanHousekeeping(settings);
  const needed = neededTaskIds(tasks);
  const old = (ms, days) => !!ms && now - ms >= days * DAY;
  const branchFact = new Map((facts.branches || []).map(b => [`${b.repo}\u0000${b.name}`, b]));

  const plan = { worktrees: [], fixups: [], branches: [], keep: [], tasks: [], reports: [], orphanDirs: [], bytes: 0 };
  const removedWorktree = new Set();

  // 1. Worktrees of finished tasks.
  for (const t of tasks) {
    if (!t.worktree || t.cleaned || ACTIVE.has(t.status)) continue;
    const f = (facts.worktrees || {})[t.id];
    if (!f || !f.exists) { plan.fixups.push(t.id); removedWorktree.add(t.id); continue; } // folder already gone
    const b = branchFact.get(`${t.repo}\u0000${t.branch}`);
    const reason = b && b.merged ? `branch merged into ${b.mergedInto}` : old(t.endedAt, s.worktreeDays) ? `finished more than ${s.worktreeDays} day(s) ago` : '';
    if (!reason) continue;
    if (needed.has(t.id)) { plan.keep.push({ kind: 'worktree', name: t.title, reason: 'a queued task still builds on it' }); continue; }
    if (f.dirty) { plan.keep.push({ kind: 'worktree', name: t.title, reason: 'it has uncommitted changes' }); continue; }
    plan.worktrees.push({ taskId: t.id, title: t.title, path: t.worktree, repo: t.repo, branch: t.branch, reason, sizeBytes: f.sizeBytes || 0 });
    plan.bytes += f.sizeBytes || 0;
    removedWorktree.add(t.id);
  }

  // 2. Agent branches whose work is already merged.
  const taskByBranch = new Map(tasks.filter(t => t.branch).map(t => [`${t.repo}\u0000${t.branch}`, t]));
  for (const b of facts.branches || []) {
    const t = taskByBranch.get(`${b.repo}\u0000${b.name}`);
    if (t && (ACTIVE.has(t.status) || needed.has(t.id))) continue; // still in use
    const liveWorktree = t && t.worktree && !t.cleaned && !removedWorktree.has(t.id);
    if (!b.merged) {
      plan.keep.push({ kind: 'branch', name: b.name, reason: `not merged${b.commits ? ` (${b.commits} commit(s) only on this branch)` : ''}; delete it yourself if you do not need it` });
      continue;
    }
    if (liveWorktree) continue; // its worktree stays this time, so the branch stays too
    plan.branches.push({ repo: b.repo, repoPath: b.repoPath, name: b.name, reason: `merged into ${b.mergedInto}`, taskId: t ? t.id : '' });
  }

  // 3. Old finished tasks and stand-ups go to the archive.
  for (const t of tasks) {
    if (!FINISHED.has(t.status) || !old(t.endedAt, s.taskDays) || needed.has(t.id)) continue;
    if (t.worktree && !t.cleaned && !removedWorktree.has(t.id)) continue; // keep while its worktree exists
    plan.tasks.push(t.id);
  }
  for (const r of reports) {
    if (FINISHED.has(r.status) && old(r.endedAt || r.createdAt, s.taskDays)) plan.reports.push(r.id);
  }

  // 4. Worktree folders no task owns (left behind by deleted tasks or crashes).
  for (const d of facts.orphanDirs || []) {
    plan.orphanDirs.push(d);
    plan.bytes += d.sizeBytes || 0;
  }
  for (const d of facts.keepDirs || []) plan.keep.push({ kind: 'folder', name: d.path, reason: d.reason });
  for (const b of facts.keepBranches || []) plan.keep.push({ kind: 'branch', name: b.name, reason: b.reason });
  return plan;
}

export const planIsEmpty = p => !p.worktrees.length && !p.fixups.length && !p.branches.length && !p.tasks.length && !p.reports.length && !p.orphanDirs.length;

/** "3 worktrees (140 MB), 2 branches, 12 old tasks" */
export function planSummary(p) {
  const mb = b => (b >= 1048576 ? `${(b / 1048576).toFixed(b >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const parts = [];
  const wt = p.worktrees.length + p.orphanDirs.length;
  if (wt) parts.push(`${wt} worktree${wt === 1 ? '' : 's'}${p.bytes ? ` (${mb(p.bytes)})` : ''}`);
  if (p.branches.length) parts.push(`${p.branches.length} merged branch${p.branches.length === 1 ? '' : 'es'}`);
  if (p.tasks.length) parts.push(`${p.tasks.length} old task${p.tasks.length === 1 ? '' : 's'}`);
  if (p.reports.length) parts.push(`${p.reports.length} old stand-up${p.reports.length === 1 ? '' : 's'}`);
  return parts.join(', ') || 'Nothing to clean up';
}
