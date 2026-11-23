// Thin wrappers over the git CLI. Every call is argv-only (no shell), so branch names and
// paths are never interpreted by a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`));
      resolve(err ? '' : stdout.replace(/\s+$/, ''));
    });
  });
}

/** True when every commit of `a` is already in `b` (git merge-base --is-ancestor). */
export function isAncestor(repo, a, b) {
  return new Promise(resolve => {
    execFile('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo, windowsHide: true }, err => resolve(!err));
  });
}

/** Whether a ref (branch, remote branch, sha) exists. */
export async function refExists(repo, ref) {
  return !!(await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }));
}

export async function currentBranch(repo) {
  return (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })) || '';
}

export async function localBranches(repo) {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], { allowFail: true });
  return out ? out.split('\n') : [];
}

export async function remoteBranches(repo) {
  const out = await git(repo, ['for-each-ref', '--sort=-committerdate', '--count=60', '--format=%(refname:short)', 'refs/remotes/origin'], { allowFail: true });
  return out ? out.split('\n').filter(b => b && b !== 'origin/HEAD' && b !== 'origin') : [];
}

// One `git worktree add` per repo at a time; parallel adds race on .git/worktrees.
const locks = new Map();
function withRepoLock(repo, fn) {
  const prev = locks.get(repo) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(repo, next.catch(() => {}));
  return next;
}

/** Create `branch` from `base` in a new worktree at `dir`. Returns the base commit sha. */
export function addWorktree(repo, dir, branch, base) {
  return withRepoLock(repo, async () => {
    const baseSha = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, dir, baseSha]);
    return baseSha;
  });
}

/** A detached worktree at a commit (no branch), for running checks on where a branch started. */
export function addDetachedWorktree(repo, dir, sha) {
  return withRepoLock(repo, async () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', dir, sha]);
  });
}

export function removeWorktree(repo, dir) {
  return withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true });
    await git(repo, ['worktree', 'prune'], { allowFail: true });
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** What a task's branch holds compared with where it started. */
export async function branchSummary(repo, baseSha, branch, worktree) {
  const commits = await git(repo, ['log', '--format=%h %s', `${baseSha}..${branch}`], { allowFail: true });
  const shortstat = await git(repo, ['diff', '--shortstat', baseSha, branch], { allowFail: true });
  const files = await git(repo, ['diff', '--stat=120', baseSha, branch], { allowFail: true });
  const dirty = worktree && fs.existsSync(worktree)
    ? await git(worktree, ['status', '--porcelain'], { allowFail: true })
    : '';
  return {
    commits: commits ? commits.split('\n') : [],
    shortstat: shortstat.trim(),
    files: files.split('\n').slice(0, 60).join('\n'),
    uncommitted: dirty ? dirty.split('\n').length : 0,
  };
}

/** Facts for the daily report: what moved in this repo recently. */
export async function recentActivity(repo, hours = 26) {
  const [branch, status, log, branches] = await Promise.all([
    currentBranch(repo),
    git(repo, ['status', '--porcelain'], { allowFail: true }),
    git(repo, ['log', '--all', `--since=${hours} hours ago`, '-n', '40', '--format=%h %an (%ar) [%D] %s'], { allowFail: true }),
    git(repo, ['for-each-ref', '--sort=-committerdate', '--count=12', '--format=%(refname:short) (%(committerdate:relative))', 'refs/heads'], { allowFail: true }),
  ]);
  return {
    branch,
    uncommitted: status ? status.split('\n').length : 0,
    commits: log ? log.split('\n') : [],
    branches: branches ? branches.split('\n') : [],
  };
}

/** A branch or ref name typed by the owner, or '' when it is not a plain, safe ref name. */
export function cleanRef(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v || v.length > 200 || v.startsWith('-') || v.includes('..') || v.endsWith('/') || v.endsWith('.lock')) return '';
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : '';
}

/** Bring remote branches up to date, when the repo has an "origin". Never fails. */
export async function fetchOrigin(repo) {
  const remotes = await git(repo, ['remote'], { allowFail: true });
  if (!remotes.split('\n').includes('origin')) return false;
  await git(repo, ['fetch', '--quiet', 'origin'], { allowFail: true });
  return true;
}

/** A ref as given, or origin/<ref> when only the remote branch exists. '' when neither does. */
export async function resolveRef(repo, ref) {
  if (await refExists(repo, ref)) return ref;
  if (!ref.startsWith('origin/') && await refExists(repo, `origin/${ref}`)) return `origin/${ref}`;
  return '';
}

/** Whether a merge was started in this worktree and not finished or aborted. */
export async function mergeInProgress(worktree) {
  return !!(await git(worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowFail: true }));
}

export async function gitVersion() {
  try {
    return await git(process.cwd(), ['--version']);
  } catch {
    return '';
  }
}
