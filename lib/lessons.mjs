// Lessons from past runs: short, durable facts about a repo that the next agent should know
// (how it builds, commands that are refused, what reviewers keep flagging). Collected after each
// run, editable by the owner, and given to every later run in that repo. Pure: no I/O.

export const MAX_LESSONS = 40;     // kept per repo
export const PROMPT_LESSONS = 12;  // given to one run
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const norm = s => str(s, 300).toLowerCase().replace(/[`'".,:;!?()]/g, '').replace(/\s+/g, ' ');

export const lessonKey = (projectId, repo) => `${projectId}/${repo || '*'}`;

/** The optional "## Lessons" section of a report: a JSON array of short strings (at most 3). */
export function parseLessons(text) {
  const sec = /##\s*Lessons\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(String(text || ''));
  if (!sec) return [];
  const block = /```(?:json)?\s*([\s\S]*?)```/i.exec(sec[1]);
  let list = [];
  if (block) { try { const v = JSON.parse(block[1]); if (Array.isArray(v)) list = v; } catch { /* ignore */ } }
  else list = sec[1].split('\n').map(l => l.replace(/^\s*[-*\d.]+\s*/, '')).filter(Boolean);
  return list.map(x => str(typeof x === 'string' ? x : x && x.text, 240)).filter(x => x.length >= 12 && !/^none\b/i.test(x)).slice(0, 3);
}

/**
 * Lessons Dev Crew can tell from a finished task without asking the agent: refused commands,
 * failed checks, and serious review findings (repeated ones gain weight).
 */
export function lessonsFromTask(t) {
  const out = [];
  for (const r of t.refused || []) {
    if (r && r.command) out.push({ text: `The command \`${str(r.command, 120)}\` is refused for agents here; use an allowed alternative instead of retrying it.`, source: 'refused' });
  }
  for (const c of t.checks || []) {
    if (c && !c.ok && !c.skipped && !c.preexisting) out.push({ text: `The ${c.label.toLowerCase()} check (\`${str(c.cmd, 120)}\`) has failed on agent branches: run it yourself and fix what it reports before finishing.`, source: 'checks' });
  }
  const rv = t.review && t.review.result;
  for (const f of (rv && rv.findings) || []) {
    if (f.severity === 'critical' || f.severity === 'major') out.push({ text: `Reviewers flagged: ${str(f.title, 160)}`, source: 'review' });
  }
  return out;
}

/** Add lessons to a repo's list: a repeat raises its count instead of adding a copy. */
export function addLessons(list, items, { at = Date.now(), taskId = '', newId = () => Math.random().toString(36).slice(2, 10) } = {}) {
  const next = [...(list || [])];
  let added = 0;
  for (const it of items) {
    const text = str(typeof it === 'string' ? it : it.text, 240);
    if (text.length < 12) continue;
    const k = norm(text);
    const have = next.find(l => norm(l.text) === k);
    if (have) { have.hits = (have.hits || 1) + 1; have.at = at; continue; }
    next.push({ id: 'l' + newId(), text, source: (it && it.source) || 'agent', hits: 1, at, firstAt: at, taskId, pinned: false });
    added++;
  }
  // keep pinned ones, then the most useful
  return { list: rank(next).slice(0, MAX_LESSONS), added };
}

/** Pinned first, then the ones seen most, then the newest. */
export function rank(list) {
  return [...(list || [])].sort((a, b) => (b.pinned - a.pinned) || ((b.hits || 1) - (a.hits || 1)) || (b.at - a.at));
}

/** The part of a run's instructions that hands on what earlier runs learned. */
export function lessonsPromptBlock(list, max = PROMPT_LESSONS) {
  const top = rank(list).filter(l => !l.muted).slice(0, max);
  if (!top.length) return '';
  return `Lessons from earlier runs in this repo (follow them; they cost earlier engineers time):\n${top.map(l => `- ${l.text}${(l.hits || 1) > 1 ? ` (seen ${l.hits} times)` : ''}`).join('\n')}`;
}

/** What a change or read-only task is asked to add at the end of its report. */
export const LESSONS_ASK = `## Lessons (optional)
Only if you learned something durable about this repo that the next engineer would want on day one (how to build or test it, a quirk, a convention, a trap), a fenced json array of at most 3 short sentences. Not about this task. Leave the section out when there is nothing.`;
