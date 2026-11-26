// A ticket led by one agent: the agent you assign it to reads the ticket and the code, splits
// the work across the crew by role, and the plan starts on its own. Parallel branches are merged
// (plan integration), the final branch is reviewed, and the lead's task then shows the result:
// one branch per repo, never pushed. A practice run throws the branches away afterwards and keeps
// only what the crew learned (lessons). Pure: no I/O.

const OPEN = new Set(['queued', 'running']);

/** Every task started for a lead ticket (plan steps, merges, fix-ups, reviews, handoffs). */
export function leadTree(rootId, tasks) {
  return tasks.filter(t => t.id !== rootId && t.leadId === rootId);
}

/**
 * The branches that hold the finished ticket: change tasks that are done with a branch, and that
 * no later change task in the same repo built on or merged in. One per repo after integration.
 */
export function finalBranches(tree) {
  const changes = tree.filter(t => t.mode === 'change' && t.branch);
  const holds = (x, t) => x !== t && x.mode === 'change' && x.repo === t.repo && (x.prevId === t.id || (x.mergeFrom || []).includes(t.id));
  return changes.filter(t => t.status === 'done' && !t.noChanges && !changes.some(x => holds(x, t)));
}

/** The commit a repo's work started from: the first change task there that built on no other one. */
export function startOf(tree, repo) {
  const mine = tree.filter(t => t.mode === 'change' && t.repo === repo && t.baseSha).sort((a, b) => a.createdAt - b.createdAt);
  const first = mine.find(t => !mine.some(x => x.id === t.prevId)) || mine[0];
  return first ? { sha: first.baseSha, base: first.base } : null;
}

/**
 * Where a lead ticket stands: 'planning' (the lead is still at it), 'working' (steps queued or
 * running), 'stuck' (a step failed, stopped or is blocked: the owner decides), 'done'.
 */
export function leadState(root, tasks) {
  if (!root || !root.lead) return null;
  if (OPEN.has(root.status)) return { state: 'planning' };
  if (root.status !== 'done') return { state: 'stuck', why: `The ${root.status === 'failed' ? 'lead failed' : 'lead stopped'} before the work was split.` };
  if (!root.plan || root.plan.status !== 'started') return { state: 'stuck', why: 'The plan has not started.' };
  const tree = leadTree(root.id, tasks);
  if (tree.some(t => OPEN.has(t.status))) return { state: 'working', open: tree.filter(t => OPEN.has(t.status)).length, total: tree.length };
  const bad = tree.filter(t => ['failed', 'stopped', 'blocked'].includes(t.status));
  if (bad.length) return { state: 'stuck', why: `${bad.length} step(s) need you: ${bad.map(t => `"${t.title}" (${t.status})`).join(', ')}.`.slice(0, 600), tasks: bad.map(t => t.id) };
  return { state: 'done', finals: finalBranches(tree).map(t => t.id) };
}

/** What the lead is told, on top of the planning rules. */
export function leadPromptBlock({ practice = false, roleName = 'lead' } = {}) {
  return `You lead this ticket as the ${roleName}. Before you plan, review the ticket and the code it touches (read the relevant files and their tests), and say in your Findings what has to change and where. Then split the work across the crew by role: give each step to the role that owns that part of the code, including your own role where it fits. The plan starts as soon as you finish, without waiting for the owner, so make every step concrete: name the files, what done looks like, and how to test it. Dev Crew merges the parallel branches, runs the project's checks and has the Code Reviewer review the result; nothing is pushed.${practice ? `\n\nThis is a practice run to learn the project: the work is done for real in throwaway branches, and the branches are deleted afterwards. What counts is what the crew learns, so plan the way you would for real work.` : ''}`;
}

/** What every step of a practice run is told. */
export const PRACTICE_NOTE = 'This is a practice run to learn the project: do the work for real on your branch (it is deleted afterwards), and in your Lessons section note what you would want to know next time about where things live, how to build and test, and the project\'s conventions.';
