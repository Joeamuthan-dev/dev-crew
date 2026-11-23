// What happens after a change task finishes, without the owner having to step in:
//  - checks failed → the same agent gets the exact errors and one more go (fix-up rounds)
//  - the branch is good → the Code Reviewer reviews it straight away (auto review)
// and which branch new work starts from when nobody picked one. Pure: no I/O.
import { failedChecks } from './quality.mjs';

export const MAX_FIX_ROUNDS = 3;

/** Workflow settings with defaults: auto review on, one fix-up round. */
export function cleanWorkflow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const n = Number(r.fixRounds);
  return {
    autoReview: r.autoReview === undefined ? true : !!r.autoReview,
    fixRounds: Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_FIX_ROUNDS) : 1,
  };
}

/** The follow-up an agent gets when Dev Crew's checks failed on its branch. */
export function fixupPrompt(failed, round, rounds) {
  const parts = failed.map(c => `### ${c.label} (\`${c.cmd}\`) failed${c.code >= 0 ? ` with exit code ${c.code}` : ''}\n\`\`\`\n${String(c.tail || '(no output)').slice(-2500)}\n\`\`\``);
  return `Dev Crew ran the project's checks on your branch, and these failed:

${parts.join('\n\n')}

Fix what they report, commit the fix, and run the same commands again before you finish. This is fix-up round ${round} of ${rounds}. If a failure is not caused by your change, or cannot be fixed safely, stop and say so in your report instead of working around it (never skip, delete or weaken tests to make them pass).`;
}

/** Whether a finished change task gets another go because its checks failed. */
export function needsFixup(t, wf) {
  return t.mode === 'change' && t.status === 'done' && !!t.worktree && !t.cleaned
    && failedChecks(t.checks).length > 0 && (t.fixups || 0) < wf.fixRounds;
}

/**
 * Whether a finished change task's branch should go to the Code Reviewer on its own.
 * ctx: { reviewerRole, kindOf(role), builtOn (another change task builds on this branch),
 *        reviewing (a review of this branch is queued or running) }
 */
export function shouldAutoReview(t, wf, ctx) {
  if (!wf.autoReview || !ctx.reviewerRole) return { ok: false, why: 'off' };
  if (t.mode !== 'change' || t.status !== 'done' || !t.branch || t.noChanges) return { ok: false, why: 'nothing to review' };
  if (!t.git || !(t.git.commits || []).length) return { ok: false, why: 'no commits' };
  if (ctx.kindOf(t.role) === 'review') return { ok: false, why: 'a review' };
  if (failedChecks(t.checks).length) return { ok: false, why: 'checks failed' };
  // a plan step that a later step builds on: the later step's branch holds this work, review that
  if (ctx.builtOn) return { ok: false, why: 'a later step builds on it' };
  if (ctx.reviewing) return { ok: false, why: 'already being reviewed' };
  // reviewed before, and nothing new since
  if ((t.reviewedCommits || 0) >= t.git.commits.length) return { ok: false, why: 'no new commits since the last review' };
  return { ok: true };
}

/**
 * The branch new work starts from when the owner did not pick one: the project's own setting,
 * then the repo's default branch (origin's HEAD, else main or master), and only then whatever
 * is checked out. Never a feature branch just because it happens to be checked out.
 */
export function pickBase({ projectBase = '', originHead = '', local = [], current = '' }) {
  if (projectBase) return { base: projectBase, why: 'the project\'s default branch' };
  const head = String(originHead || '').replace(/^origin\//, '');
  if (head && local.includes(head)) return { base: head, why: 'the repo\'s default branch' };
  if (head) return { base: `origin/${head}`, why: 'the repo\'s default branch (remote)' };
  for (const b of ['main', 'master', 'develop']) if (local.includes(b)) return { base: b, why: `the repo's ${b} branch` };
  return { base: current || 'HEAD', why: 'the checked-out branch (no main or master found)' };
}
