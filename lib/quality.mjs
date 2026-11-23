// A project's quality profile: the commands that prove a change works (build, lint, test,
// format), the conventions reviewers check, and whether Dev Crew itself runs the checks after
// each change run. Agents are told the exact bar; the Code Reviewer reviews against it.
import { spawn } from 'node:child_process';

export const CHECK_KINDS = [['build', 'Build'], ['lint', 'Lint'], ['format', 'Format check'], ['test', 'Tests']];
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** A clean profile from the config (missing or odd values fall back to "nothing set"). */
export function cleanQuality(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { commands: {}, rules: [], requireTests: !!r.requireTests, noNewWarnings: !!r.noNewWarnings, verify: r.verify === undefined ? true : !!r.verify };
  for (const [k] of CHECK_KINDS) {
    const v = str((r.commands || {})[k], 300);
    if (v && !/[\r\n]/.test(v)) out.commands[k] = v;
  }
  out.rules = (Array.isArray(r.rules) ? r.rules : String(r.rules || '').split('\n')).map(s => str(s, 300)).filter(Boolean).slice(0, 40);
  return out;
}

export const hasQuality = q => !!q && (Object.keys(q.commands).length > 0 || q.rules.length > 0 || q.requireTests || q.noNewWarnings);

/** The profile from the editor's form, for the config file ('' fields removed). */
export function qualityFromForm(f) {
  const q = cleanQuality(f);
  const out = {};
  if (Object.keys(q.commands).length) out.commands = q.commands;
  if (q.rules.length) out.rules = q.rules;
  if (q.requireTests) out.requireTests = true;
  if (q.noNewWarnings) out.noNewWarnings = true;
  if (!q.verify) out.verify = false;
  return Object.keys(out).length ? out : null;
}

/** Commands to suggest from what the repos are built with (detectRepo's stack labels). */
export function suggestQuality(stackLabels = []) {
  const s = stackLabels.join(' | ');
  if (/C#|\.NET/.test(s)) return { build: 'dotnet build', test: 'dotnet test', format: 'dotnet format --verify-no-changes' };
  if (/Angular|React|Vue|Svelte|Next|Nuxt|Express|NestJS|Fastify|Node|TypeScript/.test(s)) return { build: /TypeScript|Angular/.test(s) ? 'npx tsc --noEmit' : '', lint: 'npx eslint .', test: 'npm test' };
  if (/Python/.test(s)) return { lint: 'ruff check .', test: 'pytest' };
  if (/\bGo\b/.test(s)) return { build: 'go build ./...', lint: 'go vet ./...', test: 'go test ./...' };
  if (/Rust/.test(s)) return { build: 'cargo build', test: 'cargo test' };
  if (/Maven/.test(s)) return { build: 'mvn -q compile', test: 'mvn -q test' };
  if (/Gradle/.test(s)) return { build: 'gradle build -x test', test: 'gradle test' };
  return {};
}

/** The review checklist: the project's own rules, then the usual ones for its stack. */
export function reviewChecklist(q, stack = '') {
  const own = (q && q.rules) || [];
  const base = [
    'New or changed logic has tests that would fail without the change',
    'Errors are handled: no swallowed exceptions, useful messages, nothing leaks secrets in logs',
    'Inputs from users or other systems are validated',
    'No duplicated helper: an existing function does not already do this',
    'Callers of changed public functions, endpoints or schemas still work',
  ];
  const s = String(stack);
  if (/C#|\.NET/.test(s)) base.push('async all the way: no .Result / .Wait(), CancellationToken passed through', 'SQL is parameterised (no string concatenation), EF queries do not load whole tables', 'IDisposable resources are disposed (using)');
  if (/TypeScript|Angular|React|Vue|Node/.test(s)) base.push('No any where a real type is known; promises are awaited or handled', 'Subscriptions and listeners are cleaned up');
  if (/Python/.test(s)) base.push('No bare except; type hints on new public functions');
  if (q && q.requireTests) base.unshift('REQUIRED by the owner: every new public method, endpoint or component has a test');
  if (q && q.noNewWarnings) base.push('REQUIRED by the owner: the change adds no new compiler or linter warnings');
  return [...own, ...base].slice(0, 30);
}

/** The "quality bar" part of a change task's or a review's instructions. */
export function qualityPromptBlock(q, { forReview = false, checks = null } = {}) {
  if (!q) return '';
  const lines = [];
  const cmds = CHECK_KINDS.filter(([k]) => q.commands[k]).map(([k, l]) => `${l}: ${q.commands[k]}`);
  if (cmds.length) lines.push(`${forReview ? 'The project\'s checks' : 'Run these exact commands before you finish, and fix what they report'}:\n${cmds.map(c => `- ${c}`).join('\n')}`);
  if (q.rules.length) lines.push(`The owner's conventions for this project:\n${q.rules.map(r => `- ${r}`).join('\n')}`);
  if (q.requireTests && !forReview) lines.push('Every new public method, endpoint or component needs a test. A change without tests is not finished.');
  if (q.noNewWarnings && !forReview) lines.push('Do not add compiler or linter warnings; fix the ones your change causes.');
  if (!forReview && q.verify && cmds.length) lines.push('Dev Crew runs these checks itself on your branch after you finish, and shows the owner the results.');
  if (checks && checks.length) lines.push(`Dev Crew ran the checks on this branch:\n${checks.map(c => `- ${c.label}: ${c.ok ? 'passed' : `FAILED (exit ${c.code})`}`).join('\n')}${checks.some(c => !c.ok) ? '\nA failing check is at least a major finding.' : ''}`);
  return lines.length ? `Quality bar for this project:\n${lines.join('\n\n')}` : '';
}

/** The first word(s) of each command, so agents may run them (added to the allow list). */
export function qualityAllowRules(q) {
  if (!q) return [];
  return [...new Set(Object.values(q.commands).map(c => c.split(/\s+/).slice(0, /^(npx|npm|dotnet|go|cargo|python|pnpm|yarn|mvn|gradle)$/.test(c.split(/\s+/)[0]) ? 2 : 1).join(' ')))];
}

/**
 * Run the profile's checks in a folder, one after another (build first: a failing build makes
 * the rest pointless). Resolves [{ kind, label, cmd, ok, code, ms, tail }].
 */
export async function runChecks(q, cwd, { timeoutMs = 15 * 60e3, onStart = () => {}, isCancelled = () => false } = {}) {
  const out = [];
  for (const [kind, label] of [['build', 'Build'], ['lint', 'Lint'], ['format', 'Format check'], ['test', 'Tests']]) {
    const cmd = q && q.commands[kind];
    if (!cmd || isCancelled()) continue;
    if (out.some(c => c.kind === 'build' && !c.ok)) { out.push({ kind, label, cmd, ok: false, code: -1, ms: 0, tail: 'Skipped: the build failed.', skipped: true }); continue; }
    onStart(label, cmd);
    out.push({ kind, label, cmd, ...(await runOne(cmd, cwd, timeoutMs)) });
  }
  return out;
}

function runOne(cmd, cwd, timeoutMs) {
  const t0 = Date.now();
  return new Promise(resolve => {
    let buf = '';
    let done = false;
    const keep = d => { buf = (buf + d).slice(-6000); };
    let child;
    try {
      child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    } catch (e) {
      return resolve({ ok: false, code: -1, ms: 0, tail: e.message });
    }
    const timer = setTimeout(() => { keep(`\n[Dev Crew] Stopped after ${Math.round(timeoutMs / 60000)} minutes.`); try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code == null ? -1 : code, ms: Date.now() - t0, tail: tailOf(buf) });
    };
    child.on('error', e => { keep(String(e.message)); finish(-1); });
    child.on('close', finish);
  });
}

/** The useful end of a command's output: the last 40 lines, at most 3,000 characters. */
export function tailOf(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim()).slice(-40).join('\n').slice(-3000);
}
