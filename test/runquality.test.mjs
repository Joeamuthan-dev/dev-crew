import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRule, ruleProblem, refusedCommands, mergeRefused } from '../lib/permissions.mjs';
import { parsePlan } from '../lib/handoffs.mjs';
import { collectRuns, summarize, trialJobs } from '../lib/analytics.mjs';
import { toolPolicy } from '../lib/claude.mjs';
import { taskSystemPrompt } from '../lib/prompts.mjs';

test('a refused command becomes a short, safe rule', () => {
  assert.deepEqual(suggestRule('dotnet sln dataez-api.sln add DataEz.Api.Tests/DataEz.Api.Tests.csproj'), { rule: 'dotnet sln', problem: '' });
  assert.equal(suggestRule('dotnet --list-sdks').rule, 'dotnet --list-sdks');
  assert.equal(suggestRule('pytest tests/unit -q').rule, 'pytest');
  assert.equal(suggestRule('npm run build && npm test').rule, '');
  assert.match(suggestRule('cat a.txt | grep x').problem, /one command per call/);
  assert.match(suggestRule('git push origin main').problem, /always refused/);
  assert.match(suggestRule('rm -rf build').problem, /stay refused|always refused/);
  assert.match(ruleProblem('git'), /always refused/); // "git" would also allow git push
  assert.equal(ruleProblem('dotnet sln'), '');
  assert.match(ruleProblem('dotnet $(evil)'), /plain command/);
});

test('refused commands are kept once each, newest first', () => {
  const denials = [
    { tool_name: 'Bash', tool_input: { command: 'dotnet --list-sdks' } },
    { tool_name: 'Bash', tool_input: { command: 'dotnet --list-sdks' } },
    { tool_name: 'Edit', tool_input: { file_path: 'x' } },
    { tool_name: 'PowerShell', tool_input: { command: 'dotnet sln a.sln add b.csproj' } },
  ];
  const fresh = refusedCommands(denials);
  assert.deepEqual(fresh.map(f => f.command), ['dotnet --list-sdks', 'dotnet sln a.sln add b.csproj']);
  const merged = mergeRefused([{ command: 'dotnet --list-sdks', rule: 'dotnet --list-sdks', problem: '' }], fresh, 5);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].rule, 'dotnet sln');
  assert.equal(merged[0].at, 5);
});

test('toolchain checks are allowed for change tasks, never for read-only ones', () => {
  const has = (p, c) => p.allowed.includes(`Bash(${c}:*)`);
  assert.ok(has(toolPolicy('change'), 'dotnet --list-sdks'));
  assert.ok(has(toolPolicy('change'), 'dotnet sln'));
  assert.ok(!has(toolPolicy('analyze'), 'dotnet sln'));
});

test('agents are told which build and test commands they may run, and to report honestly', () => {
  const project = { name: 'P', stack: '', context: '', repos: [{ name: 'api', path: '/api' }], roles: {}, allowCommands: ['make check'] };
  const p = taskSystemPrompt(project, 'qa', 'change', { cwd: '/wt', branch: 'b', base: 'main' });
  assert.match(p, /dotnet build \/ test/);
  assert.match(p, /for this project: make check/);
  assert.match(p, /only if you actually ran it/);
  const plan = taskSystemPrompt(project, 'architect', 'analyze', { cwd: '/api', plan: true, handoffs: 'off' });
  assert.match(plan, /"repo" must be one of: api/);
});

test('plan steps for a repo the project lacks are marked, not dropped', () => {
  const text = '## Plan\n```json\n[{"key":"a","role":"frontend","mode":"change","repo":"portal","title":"Fix the page"},{"key":"b","role":"backend","mode":"change","repo":"api","title":"Fix the API"},{"key":"c","role":"qa","mode":"analyze","repo":"*","title":"Check it"}]\n```';
  const steps = parsePlan(text, { roleIds: ['frontend', 'backend', 'qa'], repoNames: ['api'] });
  assert.equal(steps.length, 3);
  assert.equal(steps[0].missingRepo, true);
  assert.equal(steps[1].missingRepo, undefined);
  assert.equal(steps[2].missingRepo, undefined);
  assert.equal(parsePlan(text, { roleIds: ['frontend'] })[0].missingRepo, undefined); // no repo list: no check
});

const D = (d, h = 12) => new Date(2026, 10, d, h).getTime();

test('a change task that made nothing counts as waste, not as finished work', () => {
  const tasks = [
    { id: 'a', projectId: 'p', role: 'backend', mode: 'change', title: 'Real work', status: 'done', runs: [{ at: D(23), costUsd: 0.6 }] },
    { id: 'b', projectId: 'p', role: 'frontend', mode: 'change', title: 'Nothing', status: 'done', noChanges: true, runs: [{ at: D(23), costUsd: 0.2 }] },
  ];
  const s = summarize(collectRuns({ tasks }), { from: '2026-11-23', to: '2026-11-23', tasks, now: D(23, 18) });
  assert.ok(Math.abs(s.wasted.cost - 0.2) < 1e-9);
  assert.equal(s.finished.count, 1);
});

test('graph trials show as jobs, and the chart skips the empty start of the range', () => {
  const jobs = trialJobs([{ project: 'DataEz', startedAt: D(21), model: 'sonnet', variants: ['off', 'tools'], runs: [{ costUsd: 0.2, turns: 5, ok: true }, { costUsd: 0.1, turns: 3, ok: true }] }], n => n.toLowerCase());
  assert.equal(jobs[0].projectId, 'dataez');
  assert.equal(jobs[0].role, 'graph-trial');
  const rows = collectRuns({ tasks: jobs });
  assert.equal(rows.length, 2);
  const s = summarize(rows, { from: '2026-10-25', to: '2026-11-23', tasks: jobs, now: D(23, 18) });
  assert.ok(Math.abs(s.totals.cost - 0.3) < 1e-9);
  // starts near the first spend, not on 2026-10-25, and always shows at least a week
  assert.equal(s.daily[0].day, '2026-11-17');
  assert.equal(s.daily.length, 7);
  const wide = summarize(rows, { from: '2026-09-01', to: '2026-11-30', tasks: jobs, now: D(30, 18) });
  assert.equal(wide.daily[0].day, '2026-11-19'); // two days' lead before the first spend
});
