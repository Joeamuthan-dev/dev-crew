import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectFromForm, upsertProject, removeProject, peopleFromForm, folderForConfig } from '../lib/configfile.mjs';
import { parseConfig } from '../lib/config.mjs';

const ws = path.resolve('/work');

test('projectFromForm builds a clean project and keeps fields the editor does not show', () => {
  const existing = { id: 'billing', monday: { boardId: '123' }, roles: { backend: { repo: 'api', model: 'opus' } }, custom: 1 };
  const p = projectFromForm({
    id: 'billing', name: ' Billing ', folder: path.join(ws, 'billing'), stack: '.NET 8', context: 'Invoices',
    activeRoles: ['architect', 'backend', 'qa', 'bogus'],
    roles: { backend: { repo: 'api', notes: ' Use EF ', model: '' }, qa: { repo: 'api', limits: { taskBudgetUsd: '1' } } },
    allowCommands: 'npm run e2e\n\n', handoffs: 'auto', limits: { dailyBudgetUsd: 5 },
  }, existing, ws);
  assert.equal(p.name, 'Billing');
  assert.equal(p.folder, 'billing');
  assert.deepEqual(p.activeRoles, ['architect', 'backend', 'qa']);
  assert.deepEqual(p.roles.backend, { repo: 'api', notes: 'Use EF' }); // cleared model is removed
  assert.deepEqual(p.roles.qa, { repo: 'api', limits: { taskBudgetUsd: 1 } });
  assert.deepEqual(p.allowCommands, ['npm run e2e']);
  assert.equal(p.handoffs, 'auto');
  assert.deepEqual(p.limits, { dailyBudgetUsd: 5 });
  assert.deepEqual(p.monday, { boardId: '123' });
  assert.equal(p.custom, 1);
});

test('all roles active is written as the default (no activeRoles key)', () => {
  const p = projectFromForm({ id: 'x', activeRoles: ['architect', 'frontend', 'backend', 'database', 'qa', 'devops'] }, {}, ws);
  assert.equal(p.activeRoles, undefined);
});

test('folderForConfig is relative inside the workspace, absolute outside', () => {
  assert.equal(folderForConfig(path.join(ws, 'a', 'b'), ws), 'a/b');
  assert.equal(folderForConfig(path.resolve('/elsewhere/c'), ws), path.resolve('/elsewhere/c').replace(/\\/g, '/'));
});

test('upsertProject adds, replaces, renames, and refuses duplicate ids', () => {
  let raw = { projects: [{ id: 'a' }] };
  raw = upsertProject(raw, { id: 'b' });
  assert.deepEqual(raw.projects.map(p => p.id), ['a', 'b']);
  raw = upsertProject(raw, { id: 'c', name: 'renamed' }, 'a');
  assert.deepEqual(raw.projects.map(p => p.id), ['c', 'b']);
  assert.throws(() => upsertProject(raw, { id: 'b' }, 'c'), /already exists/);
  assert.throws(() => upsertProject(raw, { id: 'b' }, 'new'), /already exists/);
  assert.deepEqual(removeProject(raw, 'b').projects.map(p => p.id), ['c']);
});

test('parseConfig catches bad ids and an empty role list', () => {
  const bad = parseConfig({ settings: {}, projects: [{ id: 'Bad Id' }, { id: 'ok', activeRoles: [] }] });
  assert.equal(bad.problems.length, 2);
  const good = parseConfig({ settings: {}, projects: [{ id: 'ok', activeRoles: ['backend', 'qa'] }] });
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.projects[0].activeRoles, ['backend', 'qa']);
});

test('peopleFromForm cleans the list', () => {
  const out = peopleFromForm([
    { name: ' Ravi ', email: 'r@x', projects: 'billing, *', roles: 'backend, bogus', skills: '.NET, EF', contractor: 'on' },
    { name: '', email: 'nobody@x' },
  ]);
  assert.deepEqual(out, [{ name: 'Ravi', email: 'r@x', contractor: true, projects: ['billing', '*'], roles: ['backend'], skills: ['.NET', 'EF'] }]);
});
