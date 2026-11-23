// Which task changes deserve an alert, and what the alert says and offers. Pure (no DOM), so the
// dashboard and the tests share it. An alert has up to two actions: open a page of the dashboard,
// or call the local API straight away (start a plan, start a handoff).

export const ALERT_EVENTS = [
  ['review', 'A branch is ready for your review'],
  ['plan', 'A plan is ready to start'],
  ['handoff', 'A role suggests a handoff'],
  ['failed', 'A task failed, stopped at a limit, or made no changes'],
  ['refused', 'An agent was refused a command'],
  ['done', 'Any other task finished'],
];
export const ALERT_DEFAULTS = { inApp: true, system: false, events: { review: true, plan: true, handoff: true, failed: true, refused: true, done: false } };

const ACTIVE = ['queued', 'running'];
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * The alerts for one task update. prev is the task before it (undefined when new). Alerts fire
 * only when a run ends, so reloading the page never replays them.
 */
export function detectAlerts(prev, t, { roleName = id => id, projectName = id => id, hasReviewer = () => false } = {}) {
  if (!prev || !ACTIVE.includes(prev.status) || ACTIVE.includes(t.status)) return [];
  const out = [];
  const who = roleName(t.role);
  const where = projectName(t.projectId);
  const open = { id: 'open', label: 'Open', kind: 'open', url: `#/t/${t.id}` };
  const base = { taskId: t.id, url: `#/t/${t.id}` };

  if (t.status === 'done') {
    const handoffs = (t.handoffs || []).filter(h => h.status === 'proposed');
    if (t.plan && t.plan.status === 'proposed') {
      const steps = t.plan.steps || [];
      const skip = steps.filter(s => s.missingRepo).length;
      out.push({ ...base, key: `${t.id}:plan`, event: 'plan', title: `Plan ready: ${clip(t.title, 80)}`,
        body: `${steps.length - skip} step${steps.length - skip === 1 ? '' : 's'}${skip ? ` (${skip} skipped)` : ''} from the ${who} on ${where}. Start it?`,
        actions: [{ id: 'plan', label: 'Start plan', kind: 'api', method: 'POST', path: `/api/tasks/${t.id}/plan/start`, doneText: 'Plan started', doneBody: `${steps.length - skip} linked task(s) are queued.` }, open] });
    } else if (handoffs.length && t.origin !== 'plan') {
      const h = handoffs[0];
      out.push({ ...base, key: `${t.id}:handoff:${h.id}`, event: 'handoff', title: `${who} suggests a handoff`,
        body: `${roleName(h.role)}: ${clip(h.title, 90)}${h.reason ? ` · ${clip(h.reason, 90)}` : ''}${handoffs.length > 1 ? ` (+${handoffs.length - 1} more)` : ''}`,
        actions: [{ id: 'handoff', label: 'Start handoff', kind: 'api', method: 'POST', path: `/api/tasks/${t.id}/handoffs/${h.id}/start`, doneText: 'Handoff started', doneBody: `The ${roleName(h.role)} is on it.` }, open] });
    } else if (t.noChanges) {
      out.push({ ...base, key: `${t.id}:nochanges`, event: 'failed', title: `No changes: ${clip(t.title, 80)}`, body: `${who} on ${where} finished without a commit. ${clip(t.summary, 140)}`, actions: [open] });
    } else if (t.mode === 'change' && (t.checks || []).some(c => !c.ok && !c.skipped && !c.preexisting)) {
      const bad = t.checks.filter(c => !c.ok && !c.skipped && !c.preexisting).map(c => c.label);
      out.push({ ...base, key: `${t.id}:checks`, event: 'failed', title: `Checks failed: ${clip(t.title, 80)}`,
        body: `${bad.join(', ')} failed on the ${who}'s branch on ${where}. Send it back with a follow-up, or look at the output.`, actions: [{ ...open, label: 'See checks' }] });
    } else if (t.mode === 'change' && t.git && t.git.commits && t.git.commits.length) {
      const ask = hasReviewer(t.projectId) && t.role !== 'reviewer'
        ? [{ id: 'review', label: 'Ask the Code Reviewer', kind: 'open', url: `#/t/${t.id}/review` }] : [];
      out.push({ ...base, key: `${t.id}:review`, event: 'review', title: `Ready for review: ${clip(t.title, 80)}`,
        body: `${who} on ${where} · ${t.git.commits.length} commit${t.git.commits.length === 1 ? '' : 's'}${t.git.shortstat ? ` · ${t.git.shortstat}` : ''}${(t.checks || []).length ? ` · checks passed${t.checks.some(c => c.preexisting) ? ' (some already failed before)' : ''}` : ''}`,
        actions: [{ ...open, label: 'Review' }, ...ask] });
    } else {
      out.push({ ...base, key: `${t.id}:done`, event: 'done', title: `Finished: ${clip(t.title, 80)}`, body: `${who} on ${where}. ${clip(t.summary, 160)}`, actions: [open] });
    }
  } else if (t.status === 'failed') {
    out.push({ ...base, key: `${t.id}:failed`, event: 'failed', title: `Failed: ${clip(t.title, 80)}`, body: `${who} on ${where}: ${clip(t.error, 160)}`, actions: [open] });
  } else if (t.status === 'stopped') {
    out.push({ ...base, key: `${t.id}:stopped`, event: 'failed', title: `Stopped at the ${t.stopReason === 'budget' ? 'cost' : 'time'} limit: ${clip(t.title, 70)}`, body: `${who} on ${where}. Continue picks up where it stopped.`, actions: [{ ...open, label: 'Continue…' }] });
  }

  // commands refused in this run (on top of whatever the run ended with)
  const fresh = (t.refused || []).length - ((prev && prev.refused) || []).length;
  if (fresh > 0) {
    out.push({ ...base, key: `${t.id}:refused:${(t.refused || []).length}`, event: 'refused', title: `${fresh} command${fresh === 1 ? ' was' : 's were'} refused`,
      body: `${who} on ${where}: ${clip(t.refused.slice(0, fresh).map(r => r.command).join(' · '), 160)}`, actions: [{ ...open, label: 'Review and allow' }] });
  }
  return out;
}
