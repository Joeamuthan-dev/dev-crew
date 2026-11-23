// The Settings page: turn the form into the "settings" block of crew.config.local.json.
// Pure (no I/O) so the rules can be unit tested. Anything not on the form is kept as it was.
import { cleanLimits } from './limits.mjs';
import { cleanHousekeeping } from './housekeeping.mjs';
import { HANDOFF_POLICIES } from './handoffs.mjs';
import { ruleProblem } from './permissions.mjs';

// Claude Code's permission modes Dev Crew lets you pick ('' = choose per task: dontAsk when this
// Claude Code has it, else acceptEdits for changes). bypassPermissions is never offered.
export const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'dontAsk'];

export const UI_DEFAULTS = { theme: 'system', motion: 'full', quality: 'high', officeView: '3d' };
const UI_CHOICES = {
  theme: ['system', 'light', 'dark'],
  motion: ['full', 'reduced', 'off'],
  quality: ['high', 'medium', 'low'],
  officeView: ['3d', '2d'],
};

export function cleanUi(raw) {
  const out = { ...UI_DEFAULTS };
  for (const [k, choices] of Object.entries(UI_CHOICES)) if (raw && choices.includes(raw[k])) out[k] = raw[k];
  return out;
}

const bool = v => v === true || v === 'true' || v === 'on' || v === 1;
const MODEL = /^[a-z0-9][a-z0-9.\-_[\]]{0,59}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The secrets a settings block may hold, with how to show them in the browser. */
export function maskSettings(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  const token = s.monday && s.monday.token;
  if (s.monday) s.monday = { ...s.monday, token: '', tokenSet: !!token, tokenHint: token ? `…${String(token).slice(-4)}` : '' };
  return s;
}

/**
 * Merge the Settings form into the existing settings block.
 * Returns { settings, errors }; errors is a list of plain sentences (empty when all is well).
 * Partial forms are fine: a section that is not sent keeps its values.
 */
export function settingsFromForm(form, existing = {}) {
  const s = JSON.parse(JSON.stringify(existing || {}));
  const errors = [];
  const f = form || {};

  if (f.model !== undefined) {
    const m = String(f.model).trim();
    if (m && !MODEL.test(m)) errors.push('Default model: use a model name such as sonnet, opus or haiku.'); else if (m) s.model = m; else delete s.model;
  }
  if (f.reportModel !== undefined) {
    const m = String(f.reportModel).trim();
    if (m && !MODEL.test(m)) errors.push('Stand-up model: use a model name such as sonnet, opus or haiku.'); else if (m) s.reportModel = m; else delete s.reportModel;
  }
  if (f.maxConcurrent !== undefined) {
    const n = Number(f.maxConcurrent);
    if (!Number.isInteger(n) || n < 1 || n > 8) errors.push('Agents at a time must be a whole number from 1 to 8.'); else s.maxConcurrent = n;
  }

  if (f.limits !== undefined) {
    const raw = { ...f.limits };
    if (raw.warnAtPercent !== undefined && raw.warnAtPercent !== '') {
      const p = Number(raw.warnAtPercent);
      if (!(p >= 50 && p <= 95)) errors.push('Warn at must be between 50% and 95%.'); else raw.warnAt = p / 100;
    }
    delete raw.warnAtPercent;
    for (const k of ['taskBudgetUsd', 'taskTimeoutMin', 'dailyBudgetUsd']) {
      if (raw[k] !== undefined && raw[k] !== '' && !(Number(raw[k]) >= 0)) errors.push(`${{ taskBudgetUsd: 'Cost limit per run', taskTimeoutMin: 'Time limit per run', dailyBudgetUsd: 'Daily spend limit' }[k]} must be 0 or more.`);
    }
    s.limits = { ...(s.limits || {}), ...cleanLimits(raw) };
  }

  if (f.handoffs !== undefined) {
    if (!HANDOFF_POLICIES.includes(f.handoffs)) errors.push('Handoffs must be ask, auto or off.'); else s.handoffs = f.handoffs;
  }

  if (f.dailyReport !== undefined) {
    const d = { ...(s.dailyReport || {}) };
    if (f.dailyReport.enabled !== undefined) d.enabled = bool(f.dailyReport.enabled);
    if (f.dailyReport.weekdaysOnly !== undefined) d.weekdaysOnly = bool(f.dailyReport.weekdaysOnly);
    if (f.dailyReport.at !== undefined) {
      if (!TIME.test(String(f.dailyReport.at))) errors.push('Stand-up time must look like 09:00.'); else d.at = String(f.dailyReport.at);
    }
    s.dailyReport = d;
  }

  if (f.housekeeping !== undefined) {
    const h = f.housekeeping;
    for (const [k, label] of [['worktreeDays', 'Keep worktrees for'], ['taskDays', 'Archive tasks after']]) {
      if (h[k] !== undefined && h[k] !== '' && !(Number(h[k]) >= 0 && Number(h[k]) <= 3650)) errors.push(`${label} must be between 0 and 3650 days.`);
    }
    s.housekeeping = cleanHousekeeping({ ...(s.housekeeping || {}), ...h, auto: h.auto === undefined ? (s.housekeeping || {}).auto : bool(h.auto) });
  }

  if (f.ui !== undefined) {
    for (const [k, choices] of Object.entries(UI_CHOICES)) {
      if (f.ui[k] !== undefined && !choices.includes(f.ui[k])) errors.push(`Appearance: ${k} must be one of ${choices.join(', ')}.`);
    }
    s.ui = cleanUi({ ...(s.ui || {}), ...f.ui });
  }

  if (f.monday !== undefined) {
    const m = { ...(s.monday || {}) };
    // The token is never sent back to the browser: blank keeps it, clearToken removes it.
    if (bool(f.monday.clearToken)) m.token = '';
    else if (f.monday.token) m.token = String(f.monday.token).trim().slice(0, 2000);
    if (f.monday.apiVersion !== undefined) m.apiVersion = String(f.monday.apiVersion).trim().slice(0, 20);
    s.monday = m;
  }

  if (f.advanced !== undefined) {
    const a = f.advanced;
    if (a.claudeCommand !== undefined) {
      const c = String(a.claudeCommand).trim();
      if (!c || c.length > 300 || /[\r\n]/.test(c)) errors.push('Claude command must be a single path or command name.'); else s.claudeCommand = c;
    }
    if (a.inheritClaudeEnv !== undefined) s.inheritClaudeEnv = bool(a.inheritClaudeEnv);
    if (a.port !== undefined && a.port !== '') {
      const n = Number(a.port);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) errors.push('Port must be a whole number from 1024 to 65535.'); else s.port = n;
    }
    if (a.workspace !== undefined) {
      const w = String(a.workspace).trim();
      if (!w || w.length > 400 || /[\r\n<>|"*?]/.test(w)) errors.push('Workspace must be a folder path.'); else s.workspace = w.replace(/\\/g, '/');
    }
    if (a.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(a.permissionMode)) errors.push(`Permission mode must be one of: ${PERMISSION_MODES.filter(Boolean).join(', ')}, or automatic.`);
      else if (a.permissionMode) s.permissionMode = a.permissionMode; else delete s.permissionMode;
    }
    if (a.strictMcp !== undefined) s.strictMcp = bool(a.strictMcp);
  }

  // Extra commands every project's change tasks may run (projects can add their own on top).
  if (f.allowCommands !== undefined) {
    const list = (Array.isArray(f.allowCommands) ? f.allowCommands : String(f.allowCommands).split('\n'))
      .map(c => String(c).trim().replace(/\s+/g, ' ')).filter(Boolean);
    const bad = list.map(c => [c, ruleProblem(c)]).filter(([, p]) => p);
    for (const [c, p] of bad) errors.push(`"${c}": ${p}`);
    if (!bad.length) { if (list.length) s.allowCommands = [...new Set(list)]; else delete s.allowCommands; }
  }

  return { settings: s, errors };
}
