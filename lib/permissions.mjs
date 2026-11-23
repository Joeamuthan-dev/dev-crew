// Commands an agent was refused, and turning one into a project rule ("allowCommands") safely.
import { DENY_CMDS } from './claude.mjs';

const CHAINING = /[;&|<>`]|\$\(/;
const ALWAYS_REFUSED_WORDS = ['rm', 'del', 'rmdir', 'Remove-Item', 'format', 'shutdown', 'curl', 'wget', 'Invoke-WebRequest', 'iwr', 'ssh', 'scp'];

/** The refused shell commands of a run, one entry per distinct command. */
export function refusedCommands(denials) {
  const out = [];
  const seen = new Set();
  for (const d of Array.isArray(denials) ? denials : []) {
    const cmd = d && d.tool_input && typeof d.tool_input.command === 'string' ? d.tool_input.command.trim() : '';
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({ tool: String(d.tool_name || ''), command: cmd.slice(0, 300) });
  }
  return out;
}

/** Why a rule must not be added, or '' when it may be. */
export function ruleProblem(rule) {
  const r = String(rule || '').trim();
  if (!r) return 'Nothing to allow.';
  if (r.length > 60 || !/^[A-Za-z0-9._\-/:=+ ]+$/.test(r)) return 'Only a plain command with no special characters can be allowed.';
  const lower = r.toLowerCase();
  if (DENY_CMDS.some(d => lower === d.toLowerCase() || lower.startsWith(`${d.toLowerCase()} `) || d.toLowerCase().startsWith(`${lower} `))) {
    return 'This command is always refused (it pushes, merges, deletes or deploys).';
  }
  if (ALWAYS_REFUSED_WORDS.includes(r.split(/\s+/)[0])) return 'Deleting files, downloading and remote access stay refused.';
  return '';
}

/**
 * The rule to offer for a refused command: its program and, when present, its subcommand or
 * option ("dotnet sln add X.csproj" -> "dotnet sln", "dotnet --list-sdks" stays as it is).
 * Chained or redirected commands get no rule: agents must run one command per call.
 */
export function suggestRule(command) {
  const c = String(command || '').trim();
  if (!c) return { rule: '', problem: 'Nothing to allow.' };
  if (CHAINING.test(c)) return { rule: '', problem: 'Chained or redirected commands are always refused; the agent should run one command per call.' };
  const words = c.split(/\s+/);
  const second = words[1] || '';
  const rule = second && /^(-{1,2}[A-Za-z][\w-]*|[A-Za-z][\w-]*)$/.test(second) && !/[./\\]/.test(second) ? `${words[0]} ${second}` : words[0];
  return { rule, problem: ruleProblem(rule) };
}

/** Merge newly refused commands into a task's list (kept across runs, newest first). */
export function mergeRefused(existing, fresh, at = Date.now()) {
  const list = Array.isArray(existing) ? [...existing] : [];
  for (const f of fresh) {
    if (list.some(x => x.command === f.command)) continue;
    const { rule, problem } = suggestRule(f.command);
    list.unshift({ ...f, rule, problem, at });
  }
  return list.slice(0, 20);
}
