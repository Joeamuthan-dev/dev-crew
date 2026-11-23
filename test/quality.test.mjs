import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanQuality, qualityFromForm, suggestQuality, reviewChecklist, qualityPromptBlock, qualityAllowRules, runChecks, tailOf, hasQuality } from '../lib/quality.mjs';
import { parseLessons, lessonsFromTask, addLessons, lessonsPromptBlock, rank, MAX_LESSONS } from '../lib/lessons.mjs';
import { integratePlan, planWaves, parsePlan } from '../lib/handoffs.mjs';
import { parseReview, reviewMarkdown } from '../lib/review.mjs';
import { taskSystemPrompt } from '../lib/prompts.mjs';
import { projectFromForm } from '../lib/configfile.mjs';

/* ---------------- quality profile ---------------- */

test('a quality profile is cleaned: commands on one line, rules from lines, verify on by default', () => {
  const q = cleanQuality({ commands: { build: ' dotnet build ', test: 'a\nb', lint: '' , bogus: 'x' }, rules: 'Thin controllers\n\n Use Result<T> ' });
  assert.deepEqual(q.commands, { build: 'dotnet build' });
  assert.deepEqual(q.rules, ['Thin controllers', 'Use Result<T>']);
  assert.equal(q.verify, true);
  assert.equal(hasQuality(cleanQuality(undefined)), false);
  assert.equal(qualityFromForm({ commands: { build: '' }, rules: '', verify: true }), null);
  assert.deepEqual(qualityFromForm({ commands: { test: 'npm test' }, requireTests: true, verify: false }), { commands: { test: 'npm test' }, requireTests: true, verify: false });
});

test('suggested commands follow the stack', () => {
  assert.equal(suggestQuality(['.NET 8 ASP.NET Core Web API (C#)']).test, 'dotnet test');
  assert.equal(suggestQuality(['Angular', 'TypeScript']).build, 'npx tsc --noEmit');
  assert.equal(suggestQuality(['Python FastAPI']).test, 'pytest');
  assert.deepEqual(suggestQuality(['Terraform']), {});
});

test('the checklist puts the owner\'s rules first and adds the stack\'s', () => {
  const list = reviewChecklist(cleanQuality({ rules: ['Use Result<T>'], requireTests: true }), '.NET 8 (C#)');
  assert.equal(list[0], 'Use Result<T>');
  assert.match(list[1], /REQUIRED by the owner/);
  assert.ok(list.some(x => /\.Result \/ \.Wait/.test(x)));
});

test('agents are told the exact commands; reviewers see the check results', () => {
  const q = cleanQuality({ commands: { build: 'dotnet build', test: 'dotnet test' }, requireTests: true });
  const forAgent = qualityPromptBlock(q);
  assert.match(forAgent, /Run these exact commands[\s\S]*Build: dotnet build[\s\S]*Tests: dotnet test/);
  assert.match(forAgent, /Dev Crew runs these checks itself/);
  const forReview = qualityPromptBlock(q, { forReview: true, checks: [{ label: 'Build', ok: true }, { label: 'Tests', ok: false, code: 1 }] });
  assert.match(forReview, /Tests: FAILED \(exit 1\)[\s\S]*at least a major finding/);
  assert.deepEqual(qualityAllowRules(cleanQuality({ commands: { build: 'dotnet build', lint: 'ruff check .', test: 'npx vitest run' } })).sort(), ['dotnet build', 'npx vitest', 'ruff'].sort());
});

test('checks run in order, and a failing build skips the rest', async () => {
  const ok = cleanQuality({ commands: { build: 'node -e "console.log(1)"', test: 'node -e "process.exit(0)"' } });
  const r1 = await runChecks(ok, process.cwd());
  assert.deepEqual(r1.map(c => [c.kind, c.ok]), [['build', true], ['test', true]]);
  const bad = cleanQuality({ commands: { build: 'node -e "console.error(\'boom\');process.exit(3)"', test: 'node -e "0"' } });
  const r2 = await runChecks(bad, process.cwd());
  assert.equal(r2[0].ok, false);
  assert.equal(r2[0].code, 3);
  assert.match(r2[0].tail, /boom/);
  assert.equal(r2[1].skipped, true);
  assert.equal(tailOf('\x1b[31mred\x1b[0m\n\n'), 'red');
});

test('the project editor saves the profile into the config', () => {
  const out = projectFromForm({ id: 'p', name: 'P', folder: 'p', activeRoles: [], quality: { commands: { build: 'dotnet build' }, rules: 'One rule here', verify: true } }, {});
  assert.deepEqual(out.quality, { commands: { build: 'dotnet build' }, rules: ['One rule here'] });
  const cleared = projectFromForm({ id: 'p', name: 'P', folder: 'p', activeRoles: [], quality: { commands: {}, rules: '', verify: true } }, { quality: { rules: ['x'] } });
  assert.equal(cleared.quality, undefined);
});

/* ---------------- stricter reviewer ---------------- */

test('a review with a failed checklist item never approves', () => {
  const text = '## Review\n```json\n{"verdict":"approve","summary":"ok","checklist":[{"item":"Tests added","status":"FAIL","note":"none"},{"item":"x","status":"weird"}],"findings":[]}\n```';
  const r = parseReview(text);
  assert.equal(r.verdict, 'request_changes');
  assert.deepEqual(r.checklist.map(c => c.status), ['fail', 'n/a']);
  assert.match(reviewMarkdown(r), /Checklist:\*\* 0 passed, 1 failed[\s\S]*❌ Tests added: none/);
});

test('the reviewer prompt asks for callers, tests, the checklist and the check results', () => {
  const p = { name: 'X', stack: '.NET 8 (C#)', context: '', repos: [{ name: 'api', path: '/x' }], roles: {}, activeRoles: null };
  const sp = taskSystemPrompt(p, 'reviewer', 'analyze', { cwd: '/x', review: { branch: 'agent/a', base: 'main' }, quality: cleanQuality({ rules: ['Use Result<T>'] }), stack: p.stack, checks: [{ label: 'Build', ok: false, code: 1 }], graphTools: true });
  assert.match(sp, /find its callers and users \(Grep, and the knowledge-graph tools/);
  assert.match(sp, /Review checklist:\n1\. Use Result<T>/);
  assert.match(sp, /Build: FAILED/);
  assert.match(sp, /"checklist": \[/);
});

/* ---------------- lessons ---------------- */

test('lessons come from the report, refused commands, failed checks and serious findings', () => {
  const report = '## Summary\nx\n## Lessons (optional)\n```json\n["Run dotnet test from the solution folder, not the project", "too short", "None"]\n```\n## Handoff\n```json\n[]\n```';
  assert.deepEqual(parseLessons(report), ['Run dotnet test from the solution folder, not the project']);
  assert.deepEqual(parseLessons('## Summary\nnothing'), []);
  const auto = lessonsFromTask({ refused: [{ command: 'dotnet --list-sdks' }], checks: [{ label: 'Tests', cmd: 'dotnet test', ok: false }], review: { result: { findings: [{ severity: 'major', title: 'Missing null check on customerId' }, { severity: 'nit', title: 'naming' }] } } });
  assert.deepEqual(auto.map(a => a.source), ['refused', 'checks', 'review']);
});

test('a repeated lesson gains weight instead of a copy; pinned and frequent ones come first', () => {
  let list = [];
  ({ list } = addLessons(list, [{ text: 'Reviewers flagged: Missing null check on customerId', source: 'review' }], { at: 1 }));
  ({ list } = addLessons(list, [{ text: 'Reviewers flagged: missing null check on customerId.', source: 'review' }, { text: 'The Api project has no tests of its own', source: 'agent' }], { at: 2 }));
  assert.equal(list.length, 2);
  assert.equal(list.find(l => /customerId/.test(l.text)).hits, 2);
  list[1].pinned = true;
  assert.equal(rank(list)[0], list[1]);
  const block = lessonsPromptBlock(list);
  assert.match(block, /seen 2 times/);
  list[0].muted = true; list[1].muted = true;
  assert.equal(lessonsPromptBlock(list), '');
  const many = addLessons([], Array.from({ length: 60 }, (_, i) => `Lesson number ${i} about the build`)).list;
  assert.equal(many.length, MAX_LESSONS);
});

test('change and read-only tasks may report lessons; plans and merges do not', () => {
  const p = { name: 'X', stack: '', context: '', repos: [{ name: 'api', path: '/x' }], roles: {}, activeRoles: null };
  assert.match(taskSystemPrompt(p, 'backend', 'change', { cwd: '/x', branch: 'b', base: 'main', lessons: 'Lessons from earlier runs in this repo:\n- use X' }), /Lessons from earlier runs[\s\S]*## Lessons \(optional\)/);
  assert.doesNotMatch(taskSystemPrompt(p, 'architect', 'analyze', { cwd: '/x', plan: true }), /## Lessons/);
});

/* ---------------- parallel plans ---------------- */

const step = (key, repo, deps = [], mode = 'change', role = 'backend') => ({ key, role, mode, title: `Step ${key}`, details: '', repo, dependsOn: deps });

test('independent steps in one repo run side by side, then a merge step joins their branches', () => {
  const steps = integratePlan([step('api', 'web'), step('ui', 'web', [], 'change', 'frontend'), step('qa', 'web', ['api', 'ui'], 'analyze', 'qa')], { mergeRole: 'conflicts' });
  // qa (read-only) needs both branches: they are merged first, and qa reads the merged one
  const merge = steps.find(s => s.integrate);
  assert.ok(merge);
  assert.equal(merge.role, 'conflicts');
  assert.deepEqual([merge.buildOn, ...merge.mergeIn].sort(), ['api', 'ui']);
  assert.deepEqual(steps.find(s => s.key === 'qa').dependsOn, [merge.key]);
  assert.equal(steps.find(s => s.key === 'qa').buildOn, merge.key);
  assert.deepEqual(planWaves(steps), [['api', 'ui'], [merge.key], ['qa']]);
  // two parallel branches nobody depends on are merged at the end
  const end = integratePlan([step('api', 'web'), step('ui', 'web')], { mergeRole: 'conflicts' });
  assert.equal(end[2].integrate, true);
  assert.deepEqual(planWaves(end), [['api', 'ui'], [end[2].key]]);
});

test('a step that needs two parallel branches starts from their merge', () => {
  const steps = integratePlan([step('a', 'web'), step('b', 'web'), step('c', 'web', ['a', 'b'])], { mergeRole: 'conflicts' });
  assert.deepEqual(steps.map(s => s.key), ['a', 'b', 'merge-a', 'c']);
  const c = steps.find(s => s.key === 'c');
  assert.deepEqual(c.dependsOn, ['merge-a']);
  assert.equal(c.buildOn, 'merge-a');
  assert.equal(steps.filter(s => s.integrate).length, 1); // c holds everything: no end merge
});

test('chains, other repos and projects without a Conflict Fixer are left alone', () => {
  const chain = integratePlan([step('a', 'web'), step('b', 'web', ['a'])], { mergeRole: 'conflicts' });
  assert.equal(chain.some(s => s.integrate), false);
  assert.equal(chain[1].buildOn, 'a');
  const twoRepos = integratePlan([step('a', 'web'), step('b', 'api')], { mergeRole: 'conflicts' });
  assert.equal(twoRepos.some(s => s.integrate), false);
  const none = integratePlan([step('a', 'web'), step('b', 'web')], {});
  assert.equal(none.length, 2);
  // parsePlan output plugs straight in
  const text = '## Plan\n```json\n[{"key":"x","role":"backend","mode":"change","repo":"web","title":"X"},{"key":"y","role":"frontend","mode":"change","repo":"web","title":"Y"}]\n```';
  assert.equal(integratePlan(parsePlan(text, { roleIds: ['backend', 'frontend'] }), { mergeRole: 'conflicts' }).length, 3);
});

test('the planner is told it may plan parallel steps only when there is a Conflict Fixer', () => {
  const p = { name: 'X', stack: '', context: '', repos: [{ name: 'web', path: '/x' }], roles: {}, activeRoles: null };
  assert.match(taskSystemPrompt(p, 'architect', 'analyze', { cwd: '/x', plan: true, canMerge: true }), /run at the same time, each on its own branch/);
  assert.match(taskSystemPrompt(p, 'architect', 'analyze', { cwd: '/x', plan: true, canMerge: false }), /put the steps that change the same repo in a chain/);
  assert.match(taskSystemPrompt(p, 'conflicts', 'change', { cwd: '/x', branch: 'b', base: 'a', mergeTarget: 'x', mergeTargets: ['x', 'y'] }), /git merge --no-ff --no-edit x, then git merge --no-ff --no-edit y/);
});
