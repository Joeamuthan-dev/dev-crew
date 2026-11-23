import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromForm, PERMISSION_MODES } from '../lib/settings.mjs';
import { projectFromForm } from '../lib/configfile.mjs';
import { parseConfig } from '../lib/config.mjs';
import { buildRoles } from '../lib/roles.mjs';

test('advanced settings: port, workspace, permission mode and strict MCP', () => {
  const { settings, errors } = settingsFromForm({ advanced: { port: '4620', workspace: 'C:\\Work\\Repos', permissionMode: 'dontAsk', strictMcp: 'on' } }, { port: 4610 });
  assert.deepEqual(errors, []);
  assert.equal(settings.port, 4620);
  assert.equal(settings.workspace, 'C:/Work/Repos');
  assert.equal(settings.permissionMode, 'dontAsk');
  assert.equal(settings.strictMcp, true);
  assert.equal(settingsFromForm({ advanced: { permissionMode: '' } }, { permissionMode: 'dontAsk' }).settings.permissionMode, undefined);
  const bad = settingsFromForm({ advanced: { port: '80', workspace: '', permissionMode: 'bypassPermissions' } });
  assert.equal(bad.errors.length, 3);
  assert.ok(!PERMISSION_MODES.includes('bypassPermissions'));
});

test('app-wide allowed commands are checked like project ones', () => {
  const ok = settingsFromForm({ allowCommands: 'dotnet ef\nnpm audit\n\nnpm audit' });
  assert.deepEqual(ok.settings.allowCommands, ['dotnet ef', 'npm audit']);
  const bad = settingsFromForm({ allowCommands: ['git push', 'rm -rf x', 'npm audit'] });
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.settings.allowCommands, undefined); // nothing saved while any is refused
  assert.equal(settingsFromForm({ allowCommands: '' }, { allowCommands: ['x'] }).settings.allowCommands, undefined);
  assert.deepEqual(parseConfig({ projects: [] }).settings.allowCommands, []);
});

test('per-role limits and the monday.com board are saved from Edit project', () => {
  const p = projectFromForm({ id: 'x', roles: { qa: { limits: { taskBudgetUsd: '3', taskTimeoutMin: '45' } }, backend: { limits: { taskBudgetUsd: '', taskTimeoutMin: '' } } }, mondayBoardId: '123456' }, {}, '/w');
  assert.deepEqual(p.roles.qa.limits, { taskBudgetUsd: 3, taskTimeoutMin: 45 });
  assert.equal(p.roles.backend, undefined);
  assert.deepEqual(p.monday, { boardId: '123456' });
  assert.equal(projectFromForm({ id: 'x', mondayBoardId: '' }, { monday: { boardId: '9' } }, '/w').monday, undefined);
  assert.deepEqual(projectFromForm({ id: 'x' }, { monday: { boardId: '9', group: 'g' } }, '/w').monday, { boardId: '9', group: 'g' }); // not on the form: kept
});

test('a role edited in Settings overrides only what changed', () => {
  const { roles } = buildRoles([{ id: 'qa', prompt: 'You are our QA lead.' }, { id: 'security', name: 'Security Engineer', prompt: 'You are the security engineer.' }]);
  const qa = roles.find(r => r.id === 'qa');
  assert.equal(qa.prompt, 'You are our QA lead.');
  assert.equal(qa.name, 'QA / Test Engineer');
  assert.ok(roles.some(r => r.id === 'security' && !r.builtIn));
});
