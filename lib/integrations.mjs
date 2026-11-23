// Integrations added in Settings: tools the agents can use (MCP servers) and notifications
// (webhooks told when tasks finish). Stored in settings.integrations; secrets (environment
// values and headers) are kept in the local config and never sent back to the browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const INTEGRATION_TYPES = ['mcp', 'webhook'];
export const WEBHOOK_FORMATS = ['slack', 'teams', 'json'];
export const WEBHOOK_EVENTS = ['done', 'review', 'failed', 'plan'];

// Pre-filled starting points. Commands come from each tool's own docs; check them there.
export const INTEGRATION_PRESETS = [
  { key: 'azure-devops', name: 'Azure DevOps', type: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', '@azure-devops/mcp', '<your-organisation>'], about: 'Work items, repos, pull requests and pipelines in Azure DevOps. Signs in with your Azure account the first time.' },
  { key: 'github', name: 'GitHub', type: 'mcp', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer <personal access token>' }, about: "GitHub's own MCP server: issues, pull requests, Actions and code search. Needs a personal access token." },
  { key: 'playwright', name: 'Playwright browser', type: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], about: 'Lets agents open pages in a real browser, click through and take screenshots: useful for QA and frontend checks.' },
  { key: 'postgres', name: 'PostgreSQL (read-only)', type: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://readonly_user@localhost/dbname'], about: 'Read-only SQL queries against a PostgreSQL database. Use a read-only user on a test copy, never production.' },
  { key: 'slack', name: 'Slack notifications', type: 'webhook', format: 'slack', url: 'https://hooks.slack.com/services/…', about: 'Posts to a Slack channel when tasks finish, fail, or wait for your review. Create an incoming webhook in Slack first.' },
  { key: 'teams', name: 'Microsoft Teams notifications', type: 'webhook', format: 'teams', url: 'https://…webhook.office.com/…', about: 'Posts to a Teams channel through an incoming webhook (or a Workflows webhook).' },
  { key: 'webhook', name: 'Webhook (JSON)', type: 'webhook', format: 'json', url: 'https://…', about: 'Sends a JSON message to any URL when tasks finish: for your own scripts, n8n, Zapier and the like.' },
  { key: 'custom-stdio', name: 'Custom MCP server (command)', type: 'mcp', transport: 'stdio', command: '', args: [], about: 'Any MCP server started with a command on this machine.' },
  { key: 'custom-http', name: 'Custom MCP server (URL)', type: 'mcp', transport: 'http', url: '', headers: {}, about: 'Any MCP server reached over HTTP (Streamable HTTP).' },
];

const str = (v, max = 400) => String(v == null ? '' : v).trim().slice(0, max);
const SECRET_SET = '__set__'; // what the browser sees in place of a stored secret
const idOf = name => str(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'tool';

/** Turn a key/value list or object into a plain object of strings. */
function pairs(v) {
  const out = {};
  if (Array.isArray(v)) for (const p of v) { const k = str(p && p.key, 100); if (k) out[k] = str(p.value, 4000); }
  else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { const kk = str(k, 100); if (kk) out[kk] = str(val, 4000); }
  return out;
}

/** Keep a stored secret when the form sends back the placeholder (or nothing) for it. */
function keepSecrets(next, prev = {}) {
  const out = {};
  for (const [k, v] of Object.entries(next)) out[k] = v === SECRET_SET || v === '' ? (prev[k] ?? '') : v;
  return out;
}

/**
 * Validate an integration from the Settings form, merging secrets from the stored version.
 * Returns { integration, errors }.
 */
export function cleanIntegration(form, existing = null, takenIds = []) {
  const f = form || {};
  const errors = [];
  const type = INTEGRATION_TYPES.includes(f.type) ? f.type : '';
  if (!type) errors.push('Pick what kind of integration this is.');
  const name = str(f.name, 60);
  if (!name) errors.push('Give the integration a name.');
  let id = existing ? existing.id : idOf(f.id || name);
  if (!existing && takenIds.includes(id)) { let n = 2; while (takenIds.includes(`${id}-${n}`)) n++; id = `${id}-${n}`; }
  if (['graphify', 'claude'].includes(id)) id = `${id}-tool`;
  const scope = {
    projects: Array.isArray(f.projects) && f.projects.length ? f.projects.map(x => str(x, 40)).filter(Boolean) : '*',
    roles: Array.isArray(f.roles) && f.roles.length ? f.roles.map(x => str(x, 40)).filter(Boolean) : '*',
  };
  const out = { id, name, type, enabled: f.enabled === undefined ? true : !!f.enabled && f.enabled !== 'false', ...scope };
  if (type === 'mcp') {
    out.transport = f.transport === 'http' ? 'http' : 'stdio';
    if (out.transport === 'stdio') {
      out.command = str(f.command, 300);
      if (!out.command || /[\r\n]/.test(out.command)) errors.push('Give the command that starts the server (for example npx).');
      out.args = (Array.isArray(f.args) ? f.args : String(f.args || '').split('\n')).map(a => str(a, 500)).filter(Boolean).slice(0, 30);
      out.env = keepSecrets(pairs(f.env), existing && existing.env);
    } else {
      out.url = str(f.url, 500);
      if (!/^https?:\/\/\S+$/.test(out.url)) errors.push('Give the server URL (https://…).');
      out.headers = keepSecrets(pairs(f.headers), existing && existing.headers);
    }
    out.tools = (Array.isArray(f.tools) ? f.tools : String(f.tools || '').split(/[\n,]/)).map(t => str(t, 100)).filter(t => /^[A-Za-z0-9_.-]+$/.test(t)).slice(0, 100);
    out.readOnlyTasks = !!f.readOnlyTasks && f.readOnlyTasks !== 'false';
    out.notes = str(f.notes, 1500);
  } else if (type === 'webhook') {
    out.format = WEBHOOK_FORMATS.includes(f.format) ? f.format : 'json';
    const url = str(f.url, 1000);
    out.url = url === SECRET_SET ? (existing && existing.url) || '' : url;
    // https only, except plain http to this machine (your own local scripts)
    if (!/^https:\/\/\S+$/.test(out.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(out.url)) errors.push('Give the webhook URL (https://…; plain http only for localhost).');
    const ev = (Array.isArray(f.events) ? f.events : []).filter(e => WEBHOOK_EVENTS.includes(e));
    out.events = ev.length ? ev : ['review', 'failed', 'plan'];
  }
  return { integration: out, errors };
}

/** The integrations as the browser may see them: secrets replaced by a placeholder. */
export function maskIntegrations(list) {
  return (Array.isArray(list) ? list : []).map(i => {
    const m = JSON.parse(JSON.stringify(i));
    for (const k of ['env', 'headers']) if (m[k]) for (const key of Object.keys(m[k])) m[k][key] = m[k][key] ? SECRET_SET : '';
    if (m.type === 'webhook' && m.url) m.url = SECRET_SET; // a webhook URL is a secret
    return m;
  });
}

const inScope = (v, x) => v === '*' || !v || (Array.isArray(v) && v.includes(x));

/** The enabled tool integrations a run may use: its project, its role, and its mode. */
export function toolsFor(list, { projectId, role, mode }) {
  return (Array.isArray(list) ? list : []).filter(i => i && i.type === 'mcp' && i.enabled !== false
    && inScope(i.projects, projectId) && inScope(i.roles, role) && (mode === 'change' || i.readOnlyTasks));
}

/** MCP config entries and allowed-tool rules for a run's integrations. */
export function mcpFor(tools, platform = process.platform) {
  const servers = {};
  const rules = [];
  for (const i of tools) {
    // On Windows, npx / npm / .cmd launchers only start through cmd /c.
    const viaCmd = platform === 'win32' && /^(npx|npm|pnpm|yarn|uvx)$|\.(cmd|bat)$/i.test(i.command || '');
    servers[i.id] = i.transport === 'http'
      ? { type: 'http', url: i.url, headers: i.headers || {} }
      : { type: 'stdio', command: viaCmd ? 'cmd' : i.command, args: viaCmd ? ['/c', i.command, ...(i.args || [])] : (i.args || []), env: i.env || {} };
    if (i.tools && i.tools.length) for (const t of i.tools) rules.push(`mcp__${i.id}__${t}`);
    else rules.push(`mcp__${i.id}`);
  }
  return { servers, rules };
}

/** Write one MCP config file for a run (graph and integrations together); returns its path. */
export function writeMcpServers(servers, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

/** What to tell an agent about the tools it has from integrations. */
export function integrationsPromptBlock(tools) {
  if (!tools.length) return '';
  return `Connected tools (MCP servers the owner added):\n${tools.map(i => `- ${i.name}: tools named mcp__${i.id}__…${i.tools && i.tools.length ? ` (only: ${i.tools.join(', ')})` : ''}.${i.notes ? ` ${i.notes}` : ''}`).join('\n')}\nUse them where they help the task. They reach real systems: never change or delete anything there unless the task asks for it, and say in your report what you did with them.`;
}

/** The webhooks to tell about an event on a project. */
export function webhooksFor(list, event, projectId) {
  return (Array.isArray(list) ? list : []).filter(i => i && i.type === 'webhook' && i.enabled !== false
    && (i.events || []).includes(event) && inScope(i.projects, projectId));
}

const EVENT_WORDS = { done: 'finished', review: 'is ready for your review', failed: 'needs attention', plan: 'has a plan ready to start' };

/** The message body for one webhook. */
export function webhookBody(format, { event, task, projectName, roleName, link = '' }) {
  const head = `${roleName} on ${projectName} ${EVENT_WORDS[event] || event}: ${task.title}`;
  const extra = [task.summary ? String(task.summary).slice(0, 400) : '', task.error && event === 'failed' ? `Error: ${String(task.error).slice(0, 300)}` : '', task.branch ? `Branch: ${task.branch}` : '', link].filter(Boolean).join('\n');
  if (format === 'slack') return { text: `*${head}*${extra ? `\n${extra}` : ''}` };
  if (format === 'teams') return { text: `**${head}**${extra ? `\n\n${extra.replace(/\n/g, '\n\n')}` : ''}` };
  return { event, project: projectName, role: roleName, task: { id: task.id, title: task.title, status: task.status, branch: task.branch || '', summary: task.summary || '', costUsd: task.costUsd || 0 }, link, text: head };
}

/** Send one webhook (never throws; returns { ok, status, error }). */
export async function sendWebhook(i, body, timeoutMs = 10000) {
  try {
    const res = await fetch(i.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, error: res.ok ? '' : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'No answer within 10 seconds.' : e.message };
  }
}

/* ---------------- testing an MCP server: start it, list its tools ---------------- */

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dev-crew', version: '1' } } };

/** Start a stdio MCP server and list its tools. Resolves { ok, tools, error }. */
export function testStdio(i, timeoutMs = 45000) {
  return new Promise(resolve => {
    let child;
    let buf = '';
    let err = '';
    let done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(r); };
    try {
      // started the way Claude Code will start it (cmd /c only for npx-style launchers on Windows)
      const s = mcpFor([{ ...i, id: 'test', transport: 'stdio' }]).servers.test;
      child = spawn(s.command, s.args, { env: { ...process.env, ...(i.env || {}) }, windowsHide: true });
    } catch (e) { return resolve({ ok: false, tools: [], error: e.message }); }
    const timer = setTimeout(() => finish({ ok: false, tools: [], error: `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.${err ? ` It said: ${err.trim().slice(-300)}` : ''}` }), timeoutMs);
    const send = m => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { /* closed */ } };
    child.stdout.on('data', d => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish({ ok: false, tools: [], error: m.error.message || 'initialize failed' });
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (m.id === 2) {
          finish(m.error ? { ok: false, tools: [], error: m.error.message } : { ok: true, tools: (m.result.tools || []).map(t => t.name) });
        }
      }
    });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    child.on('error', e => finish({ ok: false, tools: [], error: /ENOENT/.test(e.message) ? `"${i.command}" was not found on this machine.` : e.message }));
    child.on('close', code => finish({ ok: false, tools: [], error: `The server stopped (exit code ${code}).${err ? ` It said: ${err.trim().slice(-300)}` : ''}` }));
    send(INIT);
  });
}

/** Read one JSON-RPC reply from a Streamable HTTP response (plain JSON or an event stream). */
async function rpcReply(res, id) {
  const text = await res.text();
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5)); if (m.id === id) return m; } catch { /* keep looking */ }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/** Connect to an HTTP MCP server and list its tools. */
export async function testHttp(i, timeoutMs = 20000) {
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(i.headers || {}) };
  try {
    const r1 = await fetch(i.url, { method: 'POST', headers: base, body: JSON.stringify(INIT), signal: AbortSignal.timeout(timeoutMs) });
    if (!r1.ok) return { ok: false, tools: [], error: r1.status === 401 || r1.status === 403 ? `Not allowed (HTTP ${r1.status}): check the token or headers.` : `HTTP ${r1.status}` };
    const session = r1.headers.get('mcp-session-id');
    const m1 = await rpcReply(r1, 1);
    if (!m1 || m1.error) return { ok: false, tools: [], error: (m1 && m1.error && m1.error.message) || 'The server did not answer like an MCP server.' };
    const h2 = { ...base, ...(session ? { 'mcp-session-id': session } : {}) };
    await fetch(i.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
    const r2 = await fetch(i.url, { method: 'POST', headers: h2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), signal: AbortSignal.timeout(timeoutMs) });
    const m2 = await rpcReply(r2, 2);
    if (!m2 || m2.error) return { ok: false, tools: [], error: (m2 && m2.error && m2.error.message) || `Listing tools failed (HTTP ${r2.status}).` };
    return { ok: true, tools: (m2.result.tools || []).map(t => t.name) };
  } catch (e) {
    return { ok: false, tools: [], error: e.name === 'TimeoutError' ? 'No answer in time.' : e.message };
  }
}
