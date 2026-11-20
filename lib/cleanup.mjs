// Housekeeping, the part that touches the disk: gathers the facts lib/housekeeping.mjs decides
// on, and carries out a plan. Every destructive step re-checks its safety condition right before
// acting, because things may have changed since the preview.
import fs from 'node:fs';
import path from 'node:path';
import * as G from './git.mjs';

/** Bytes used by a folder (follows no links; stops counting after `limit` files). */
export async function dirSize(dir, limit = 200000) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const d = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        try { total += (await fs.promises.stat(p)).size; } catch { /* vanished */ }
      }
    }
  }
  return total;
}

/** Is a branch's work already in its base (locally or on origin)? Returns the ref it is in, or ''. */
async function mergedInto(repoPath, branch, bases) {
  for (const b of bases) {
    if (!b || b === branch) continue;
    for (const ref of [b, `origin/${b}`]) {
      if (await G.refExists(repoPath, ref) && await G.isAncestor(repoPath, branch, ref)) return ref;
    }
  }
  return '';
}

/** Facts for planHousekeeping: worktree state, local agent branches, orphan worktree folders. */
export async function gatherFacts({ projects, tasks, worktreeRoot }) {
  const facts = { worktrees: {}, branches: [], orphanDirs: [] };

  for (const t of tasks) {
    if (!t.worktree || t.cleaned) continue;
    const exists = fs.existsSync(t.worktree);
    facts.worktrees[t.id] = {
      exists,
      dirty: exists ? !!(await G.git(t.worktree, ['status', '--porcelain'], { allowFail: true })) : false,
      sizeBytes: exists ? await dirSize(t.worktree) : 0,
    };
  }

  for (const p of projects) {
    for (const r of p.repos) {
      if (!r.exists) continue;
      const out = await G.git(r.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent'], { allowFail: true });
      const current = await G.currentBranch(r.path);
      // Branches checked out in any worktree: ours, another Dev Crew copy's, or the owner's.
      const wtList = await G.git(r.path, ['worktree', 'list', '--porcelain'], { allowFail: true });
      const checkedOut = new Map();
      let wtPath = '';
      for (const line of wtList.split('\n')) {
        if (line.startsWith('worktree ')) wtPath = line.slice(9);
        else if (line.startsWith('branch refs/heads/')) checkedOut.set(line.slice(18), wtPath);
      }
      const ownWorktrees = new Set(tasks.filter(t => t.worktree && !t.cleaned).map(t => canonical(t.worktree)));
      for (const name of out ? out.split('\n') : []) {
        const t = tasks.find(x => x.projectId === p.id && x.repo === r.name && x.branch === name);
        if (name === current) continue; // checked out in the main working copy: leave it alone
        const at = checkedOut.get(name);
        if (at && !ownWorktrees.has(canonical(at))) {
          facts.keepBranches = facts.keepBranches || [];
          facts.keepBranches.push({ name, reason: `checked out in another worktree (${at}); remove that worktree first` });
          continue;
        }
        const bases = [t && t.base, current, 'main', 'master'];
        const into = await mergedInto(r.path, name, [...new Set(bases)]);
        const base = (t && t.base) || current;
        const commits = into ? 0 : Number(await G.git(r.path, ['rev-list', '--count', `${base}..${name}`], { allowFail: true })) || 0;
        facts.branches.push({ repo: r.name, repoPath: r.path, name, merged: !!into, mergedInto: into, commits });
      }
    }
  }

  // Folders under data/worktrees/<project>/<taskId> that no task owns any more. Paths are compared
  // in their real, canonical form: on Windows the same folder can be written with a short 8.3 name
  // (JOE~1.RAY), another letter case or other slashes, and a plain string match would call a live
  // worktree an orphan.
  const owned = new Set(tasks.filter(t => t.worktree && !t.cleaned).map(t => canonical(t.worktree)));
  const ownedIds = new Set(tasks.filter(t => t.worktree && !t.cleaned).map(t => t.id));
  for (const proj of safeDirs(worktreeRoot)) {
    for (const id of safeDirs(path.join(worktreeRoot, proj))) {
      const dir = path.join(worktreeRoot, proj, id);
      if (owned.has(canonical(dir)) || ownedIds.has(id)) continue;
      // Belt and braces: never call a folder with uncommitted work an orphan.
      if (fs.existsSync(path.join(dir, '.git')) && await G.git(dir, ['status', '--porcelain'], { allowFail: true })) {
        facts.keepDirs = facts.keepDirs || [];
        facts.keepDirs.push({ path: dir, reason: 'leftover worktree with uncommitted changes' });
        continue;
      }
      facts.orphanDirs.push({ path: dir, project: proj, sizeBytes: await dirSize(dir) });
    }
  }
  return facts;
}

/** A path in one canonical form: real (8.3 names expanded), resolved, and lower-case on Windows. */
export function canonical(p) {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* does not exist: keep the resolved form */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function safeDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
}

/**
 * Carry out a plan. `ctx` gives access to the server's state:
 * { tasks, reports, repoPathFor(task), log(taskId, kind, text), archiveDir, logDir, removeJob(kind, id) }
 * Returns what was done and what was skipped (and why).
 */
export async function runPlan(plan, ctx) {
  const done = { worktrees: 0, branches: 0, tasks: 0, reports: 0, orphanDirs: 0, bytes: 0 };
  const skipped = [];
  const byId = id => ctx.tasks.find(t => t.id === id);

  for (const id of plan.fixups) {
    const t = byId(id);
    if (t && !t.cleaned) { t.cleaned = true; ctx.log(id, 'sys', 'Worktree folder was already gone; marked as removed.'); }
  }

  for (const w of plan.worktrees) {
    const t = byId(w.taskId);
    if (!t || t.cleaned) continue;
    const repoPath = ctx.repoPathFor(t);
    if (['queued', 'running', 'blocked'].includes(t.status)) { skipped.push({ name: w.title, reason: 'the task is active again' }); continue; }
    if (fs.existsSync(w.path) && await G.git(w.path, ['status', '--porcelain'], { allowFail: true })) {
      skipped.push({ name: w.title, reason: 'it has uncommitted changes now' });
      continue;
    }
    if (!repoPath) { skipped.push({ name: w.title, reason: 'its repo was not found' }); continue; }
    await G.removeWorktree(repoPath, w.path);
    t.cleaned = true;
    ctx.log(t.id, 'sys', `Housekeeping removed the worktree (${w.reason}). Branch ${t.branch} is kept unless it is merged.`);
    done.worktrees++;
    done.bytes += w.sizeBytes || 0;
  }

  for (const b of plan.branches) {
    // Re-check right before deleting: not checked out anywhere, still fully merged.
    const wtNow = await G.git(b.repoPath, ['worktree', 'list', '--porcelain'], { allowFail: true });
    if (wtNow.split('\n').includes(`branch refs/heads/${b.name}`)) { skipped.push({ name: b.name, reason: 'it is checked out in a worktree' }); continue; }
    const into = b.reason.replace(/^merged into /, '');
    if (!(await G.isAncestor(b.repoPath, b.name, into))) { skipped.push({ name: b.name, reason: `no longer fully merged into ${into}` }); continue; }
    const t = b.taskId && byId(b.taskId);
    if (t && t.worktree && !t.cleaned) { skipped.push({ name: b.name, reason: 'its worktree is still there' }); continue; }
    try {
      await G.git(b.repoPath, ['branch', '-D', b.name]); // safe: every commit is in `into`
      if (t) ctx.log(t.id, 'sys', `Housekeeping deleted branch ${b.name} (${b.reason}).`);
      done.branches++;
    } catch (e) {
      skipped.push({ name: b.name, reason: e.message.split('\n')[0] });
    }
  }

  // Orphan folders: prune git's records for them, then delete the folder.
  const liveWorktrees = new Set(ctx.tasks.filter(t => t.worktree && !t.cleaned).map(t => canonical(t.worktree)));
  for (const d of plan.orphanDirs) {
    // Re-check: still not a task's worktree, still no uncommitted work.
    if (liveWorktrees.has(canonical(d.path))) { skipped.push({ name: d.path, reason: 'it belongs to a task' }); continue; }
    if (fs.existsSync(path.join(d.path, '.git')) && await G.git(d.path, ['status', '--porcelain'], { allowFail: true })) {
      skipped.push({ name: d.path, reason: 'it has uncommitted changes' });
      continue;
    }
    try {
      fs.rmSync(d.path, { recursive: true, force: true });
      done.orphanDirs++;
      done.bytes += d.sizeBytes || 0;
    } catch (e) {
      skipped.push({ name: d.path, reason: e.message });
    }
  }
  for (const repoPath of ctx.allRepoPaths()) await G.git(repoPath, ['worktree', 'prune'], { allowFail: true });

  // Archive old tasks and stand-ups, by the month they ended in, and move their logs along.
  const archive = {};
  const add = (kind, job) => {
    const d = new Date(job.endedAt || job.createdAt || Date.now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (archive[key] = archive[key] || { tasks: [], reports: [] })[kind].push(job);
  };
  for (const id of plan.tasks) {
    const t = byId(id);
    if (!t || (t.worktree && !t.cleaned)) continue;
    add('tasks', t);
    ctx.removeJob('task', id);
    done.tasks++;
  }
  for (const id of plan.reports) {
    const r = ctx.reports.find(x => x.id === id);
    if (!r) continue;
    add('reports', r);
    ctx.removeJob('report', id);
    done.reports++;
  }
  const logArchive = path.join(ctx.archiveDir, 'logs');
  for (const [month, data] of Object.entries(archive)) {
    fs.mkdirSync(logArchive, { recursive: true });
    const file = path.join(ctx.archiveDir, `${month}.json`);
    let prev = { tasks: [], reports: [] };
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new month */ }
    fs.writeFileSync(file, JSON.stringify({ tasks: [...prev.tasks, ...data.tasks], reports: [...prev.reports, ...data.reports] }, null, 1));
    for (const job of [...data.tasks, ...data.reports]) {
      const from = path.join(ctx.logDir, `${job.id}.jsonl`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(logArchive, `${job.id}.jsonl`));
    }
  }
  return { done, skipped };
}

/** Delete leftovers in data/tmp (system-prompt files from runs that were interrupted). */
export function clearTmp(tmpDir) {
  let n = 0;
  for (const f of (() => { try { return fs.readdirSync(tmpDir); } catch { return []; } })()) {
    try { fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true }); n++; } catch { /* in use */ }
  }
  return n;
}
