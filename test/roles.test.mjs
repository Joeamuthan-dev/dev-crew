import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_ROLES, buildRoles, setRoles, ROLES, ROLE_IDS, roleById, roleKind } from '../lib/roles.mjs';
import { parseConfig } from '../lib/config.mjs';
import { toolPolicy } from '../lib/claude.mjs';
import { taskSystemPrompt } from '../lib/prompts.mjs';
import { parseReview, reviewMarkdown, reviewCounts } from '../lib/review.mjs';
import { cleanRef } from '../lib/git.mjs';

test('the built-in crew has the Code Reviewer and the Conflict Fixer', () => {
  const ids = BUILT_IN_ROLES.map(r => r.id);
  assert.deepEqual(ids, ['architect', 'frontend', 'backend', 'database', 'qa', 'devops', 'reviewer', 'conflicts']);
  assert.equal(roleById('reviewer').kind, 'review');
  assert.equal(roleById('reviewer').defaultMode, 'analyze');
  assert.equal(roleKind('conflicts'), 'conflicts');
  assert.equal(roleKind('backend'), '');
});

test('buildRoles adds custom roles and changes built-in ones', () => {
  const { roles, problems } = buildRoles([
    { id: 'security', name: 'Security Engineer', prompt: 'You are the Security Engineer.', color: '#E11D48', defaultMode: 'analyze' },
    { id: 'qa', name: 'Test Lead', color: '#123456' },
  ]);
  assert.deepEqual(problems, []);
  const sec = roles.find(r => r.id === 'security');
  assert.equal(sec.short, 'SEC');
  assert.equal(sec.color, '#e11d48');
  assert.equal(sec.builtIn, false);
  const qa = roles.find(r => r.id === 'qa');
  assert.equal(qa.name, 'Test Lead');
  assert.equal(qa.color, '#123456');
  assert.match(qa.prompt, /QA \/ Test Engineer/); // the prompt it did not change is kept
  assert.equal(roles.length, BUILT_IN_ROLES.length + 1);
  // the built-in list itself is never changed
  assert.equal(BUILT_IN_ROLES.find(r => r.id === 'qa').name, 'QA / Test Engineer');
});

test('buildRoles reports bad entries and skips them', () => {
  const { roles, problems } = buildRoles([
    { id: 'Bad Id', name: 'x', prompt: 'y' },
    { id: 'docs', name: 'Docs Writer' },
    { id: 'ux', name: 'UX', prompt: 'p', color: 'red', kind: 'magic' },
    'nope',
  ]);
  assert.equal(problems.length, 5);
  assert.ok(!roles.some(r => r.id === 'docs'));
  const ux = roles.find(r => r.id === 'ux');
  assert.equal(ux.color, '#64748b');
  assert.equal(ux.kind, undefined);
  assert.deepEqual(buildRoles({}).problems, ['"roles" must be a list.']);
});

test('parseConfig validates projects against the config roles and defaults to all of them', () => {
  const raw = {
    roles: [{ id: 'security', name: 'Security Engineer', prompt: 'You are the Security Engineer.' }],
    projects: [
      { id: 'a', roles: { security: { repo: 'api' } } },
      { id: 'b', activeRoles: ['backend', 'security'], roles: { nobody: {} } },
    ],
  };
  const cfg = parseConfig(raw);
  assert.ok(cfg.roles.some(r => r.id === 'security'));
  assert.equal(cfg.projects[0].roles.security.repo, 'api');
  assert.ok(cfg.projects[0].activeRoles.includes('reviewer'));
  assert.ok(cfg.projects[0].activeRoles.includes('security'));
  assert.deepEqual(cfg.projects[1].activeRoles, ['backend', 'security']);
  assert.equal(cfg.problems.length, 1);
  assert.match(cfg.problems[0], /unknown role "nobody"/);
});

test('setRoles updates the live list that other modules read', () => {
  const before = ROLES;
  try {
    setRoles(buildRoles([{ id: 'security', name: 'Security Engineer', prompt: 'p' }]).roles);
    assert.ok(ROLE_IDS.includes('security'));
    assert.equal(roleById('security').name, 'Security Engineer');
  } finally {
    setRoles(before);
  }
  assert.ok(!ROLE_IDS.includes('security'));
});

test('only the Conflict Fixer may run git merge', () => {
  const has = (list, cmd) => list.some(r => r.startsWith(`Bash(${cmd}:`));
  const fixer = toolPolicy('change', [], 'conflicts');
  assert.ok(has(fixer.allowed, 'git merge'));
  assert.ok(!has(fixer.disallowed, 'git merge'));
  assert.ok(has(fixer.disallowed, 'git push'));
  assert.ok(has(fixer.disallowed, 'git rebase'));
  for (const p of [toolPolicy('change'), toolPolicy('change', [], 'review'), toolPolicy('analyze', [], 'conflicts')]) {
    assert.ok(!has(p.allowed, 'git merge'));
    assert.ok(has(p.disallowed, 'git merge'));
  }
  assert.ok(!toolPolicy('analyze', [], 'review').allowed.includes('Edit'));
});

const project = { name: 'Demo', stack: '', context: '', repos: [], roles: {}, activeRoles: null };

test('the Code Reviewer prompt names the branches and asks for a Review block', () => {
  const p = taskSystemPrompt(project, 'reviewer', 'analyze', { cwd: '/repo', review: { branch: 'feature/x', base: 'origin/main', prNumber: '12' }, handoffs: 'off' });
  assert.match(p, /git diff origin\/main\.\.\.feature\/x/);
  assert.match(p, /pull request #12/);
  assert.match(p, /git show feature\/x:<path>/);
  assert.match(p, /## Review/);
  assert.doesNotMatch(p, /## Handoff/);
  // reading the branch's own worktree: plain Read works
  const wt = taskSystemPrompt(project, 'reviewer', 'analyze', { cwd: '/wt', readFrom: '/wt', review: { branch: 'agent/be/x', base: 'main' } });
  assert.match(wt, /that branch's worktree/);
});

test('the Conflict Fixer prompt merges the target and allows aborting', () => {
  const p = taskSystemPrompt(project, 'conflicts', 'change', { cwd: '/wt', branch: 'agent/conflicts/x', base: 'feature/x', mergeTarget: 'origin/main', handoffs: 'off' });
  assert.match(p, /git merge --no-ff --no-edit origin\/main/);
  assert.match(p, /git merge --abort/);
  assert.doesNotMatch(p, /Never push, merge, rebase/);
  // without a target it is an ordinary change task
  const plain = taskSystemPrompt(project, 'conflicts', 'change', { cwd: '/wt', branch: 'b', base: 'main' });
  assert.match(plain, /Never push, merge, rebase/);
});

test('parseReview reads the verdict and findings, most severe first', () => {
  const text = `## Summary
Looks mostly fine.
## Review
\`\`\`json
{"verdict": "approve", "summary": "One real bug.", "findings": [
  {"file": "a.js", "line": "3", "severity": "nit", "title": "Name"},
  {"file": "b.js", "line": 10, "severity": "MAJOR", "title": "Null deref", "detail": "crashes when x is empty", "suggestion": "guard it"},
  {"severity": "weird", "detail": "something odd here"}
]}
\`\`\``;
  const r = parseReview(text);
  assert.equal(r.verdict, 'request_changes'); // a major finding never approves
  assert.deepEqual(r.findings.map(f => f.severity), ['major', 'minor', 'nit']);
  assert.equal(r.findings[0].line, 10);
  assert.equal(r.findings[2].line, 3);
  assert.equal(r.findings[1].title, 'something odd here');
  assert.deepEqual(reviewCounts(r), { critical: 0, major: 1, minor: 1, nit: 1 });
  assert.equal(parseReview('## Summary\nno block'), null);
  assert.equal(parseReview('```json\n[1,2]\n```'), null);
});

test('reviewMarkdown lists the findings for the pull request', () => {
  const md = reviewMarkdown({ verdict: 'comment', summary: 'S', findings: [{ file: 'b.js', line: 10, severity: 'major', title: 'Null deref', detail: 'd', suggestion: 's' }] }, { branch: 'feature/x', base: 'main' });
  assert.match(md, /### Comments · `feature\/x` → `main`/);
  assert.match(md, /- \*\*major\*\* · `b\.js:10`: Null deref/);
  assert.match(md, /\*Suggestion:\* s/);
  assert.match(reviewMarkdown({ verdict: 'approve', summary: '', findings: [] }), /No problems found/);
});

test('cleanRef keeps plain branch names only', () => {
  assert.equal(cleanRef(' origin/feature/x-1.2 '), 'origin/feature/x-1.2');
  for (const bad of ['', '-x', 'a..b', 'a b', 'x;rm', 'a/', 'x.lock', 'a~1', '$(x)']) assert.equal(cleanRef(bad), '', bad);
});
