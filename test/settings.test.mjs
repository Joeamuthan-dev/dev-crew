import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsFromForm, maskSettings, cleanUi, UI_DEFAULTS } from '../lib/settings.mjs';

const existing = {
  port: 4610, workspace: 'C:/Work', model: 'sonnet', maxConcurrent: 2,
  limits: { taskBudgetUsd: 2 }, dailyReport: { enabled: false, at: '09:00', weekdaysOnly: true },
  monday: { token: 'secret-token-1234', apiVersion: '' }, custom: 'kept',
};

test('a full valid form is merged; fields not on the form are kept', () => {
  const { settings: s, errors } = settingsFromForm({
    model: 'opus', reportModel: 'haiku', maxConcurrent: '3',
    limits: { taskBudgetUsd: '5', taskTimeoutMin: '45', dailyBudgetUsd: '30', warnAtPercent: '90' },
    handoffs: 'auto',
    dailyReport: { enabled: 'on', at: '08:30', weekdaysOnly: false },
    housekeeping: { worktreeDays: '3', taskDays: '60', auto: true },
    ui: { theme: 'dark', motion: 'reduced', quality: 'low', officeView: '2d' },
    advanced: { claudeCommand: 'claude', inheritClaudeEnv: false },
  }, existing);
  assert.deepEqual(errors, []);
  assert.equal(s.model, 'opus');
  assert.equal(s.reportModel, 'haiku');
  assert.equal(s.maxConcurrent, 3);
  assert.deepEqual(s.limits, { taskBudgetUsd: 5, taskTimeoutMin: 45, dailyBudgetUsd: 30, warnAt: 0.9 });
  assert.equal(s.handoffs, 'auto');
  assert.deepEqual(s.dailyReport, { enabled: true, at: '08:30', weekdaysOnly: false });
  assert.deepEqual(s.housekeeping, { worktreeDays: 3, taskDays: 60, auto: true });
  assert.deepEqual(s.ui, { theme: 'dark', motion: 'reduced', quality: 'low', officeView: '2d' });
  assert.equal(s.claudeCommand, 'claude');
  assert.equal(s.inheritClaudeEnv, false);
  assert.equal(s.port, 4610);
  assert.equal(s.workspace, 'C:/Work');
  assert.equal(s.custom, 'kept');
  assert.equal(s.monday.token, 'secret-token-1234'); // not on the form: untouched
});

test('a partial form only changes its own section', () => {
  const { settings: s, errors } = settingsFromForm({ ui: { theme: 'light' } }, existing);
  assert.deepEqual(errors, []);
  assert.deepEqual(s.ui, { ...UI_DEFAULTS, theme: 'light' });
  assert.equal(s.model, 'sonnet');
  assert.deepEqual(s.limits, { taskBudgetUsd: 2 });
});

test('bad values are reported in plain words and not applied', () => {
  const { settings: s, errors } = settingsFromForm({
    model: 'not a model!', maxConcurrent: '12', limits: { taskBudgetUsd: '-1', warnAtPercent: '20' },
    handoffs: 'sometimes', dailyReport: { at: '9am' }, housekeeping: { worktreeDays: '-3' },
    ui: { theme: 'pink' }, advanced: { claudeCommand: '' },
  }, existing);
  assert.equal(errors.length, 9);
  assert.match(errors.join(' '), /Agents at a time must be a whole number from 1 to 8/);
  assert.match(errors.join(' '), /Stand-up time must look like 09:00/);
  assert.equal(s.model, 'sonnet');
  assert.equal(s.maxConcurrent, 2);
});

test('the monday token: blank keeps it, a new one replaces it, clear removes it', () => {
  assert.equal(settingsFromForm({ monday: { token: '' } }, existing).settings.monday.token, 'secret-token-1234');
  assert.equal(settingsFromForm({ monday: { token: 'new-token' } }, existing).settings.monday.token, 'new-token');
  assert.equal(settingsFromForm({ monday: { token: 'x', clearToken: true } }, existing).settings.monday.token, '');
});

test('maskSettings never returns the token', () => {
  const m = maskSettings(existing);
  assert.equal(m.monday.token, '');
  assert.equal(m.monday.tokenSet, true);
  assert.equal(m.monday.tokenHint, '…1234');
  assert.equal(existing.monday.token, 'secret-token-1234'); // the original is not changed
  assert.equal(JSON.stringify(m).includes('secret-token'), false);
});

test('cleanUi falls back to defaults', () => {
  assert.deepEqual(cleanUi({ theme: 'dark', motion: 'wild' }), { ...UI_DEFAULTS, theme: 'dark' });
  assert.deepEqual(cleanUi(null), UI_DEFAULTS);
});
