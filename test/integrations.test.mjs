import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { cleanIntegration, maskIntegrations, toolsFor, mcpFor, webhooksFor, webhookBody, integrationsPromptBlock, testStdio, testHttp, sendWebhook, INTEGRATION_PRESETS } from '../lib/integrations.mjs';

test('a tool integration is validated, and its secrets survive an edit', () => {
  const { integration: a, errors } = cleanIntegration({ type: 'mcp', name: 'Azure DevOps', transport: 'stdio', command: 'npx', args: '-y\n@azure-devops/mcp\nmyorg', env: [{ key: 'ADO_PAT', value: 'secret-1' }] }, null, ['azure-devops']);
  assert.deepEqual(errors, []);
  assert.equal(a.id, 'azure-devops-2'); // the id is unique
  assert.deepEqual(a.args, ['-y', '@azure-devops/mcp', 'myorg']);
  assert.equal(a.projects, '*');
  assert.equal(a.readOnlyTasks, false);
  const masked = maskIntegrations([a])[0];
  assert.equal(masked.env.ADO_PAT, '__set__');
  const { integration: b } = cleanIntegration({ ...masked, name: 'ADO', env: [{ key: 'ADO_PAT', value: '__set__' }] }, a, []);
  assert.equal(b.env.ADO_PAT, 'secret-1'); // kept
  assert.equal(b.id, a.id);
  assert.equal(cleanIntegration({ type: 'mcp', name: 'x', transport: 'http', url: 'ftp://nope' }).errors.length, 1);
  assert.equal(cleanIntegration({ type: 'mcp', name: '', transport: 'stdio', command: '' }).errors.length, 2);
});

test('a webhook keeps its URL secret, and defaults to the events that need you', () => {
  const { integration: w } = cleanIntegration({ type: 'webhook', name: 'Slack', format: 'slack', url: 'https://hooks.slack.com/services/x' });
  assert.deepEqual(w.events, ['review', 'failed', 'plan']);
  assert.equal(maskIntegrations([w])[0].url, '__set__');
  assert.equal(cleanIntegration({ ...w, url: '__set__' }, w).integration.url, 'https://hooks.slack.com/services/x');
  assert.equal(cleanIntegration({ type: 'webhook', name: 'x', url: 'http://plain' }).errors.length, 1); // https only
});

test('a run gets only the tools for its project, role and kind of task', () => {
  const list = [
    { id: 'ado', name: 'ADO', type: 'mcp', transport: 'stdio', command: 'npx', args: [], projects: '*', roles: '*', readOnlyTasks: false },
    { id: 'pw', name: 'Browser', type: 'mcp', transport: 'stdio', command: 'npx', args: [], projects: ['dataez'], roles: ['qa', 'frontend'], readOnlyTasks: true, tools: ['browser_navigate'] },
    { id: 'off', name: 'Off', type: 'mcp', transport: 'http', url: 'https://x', projects: '*', roles: '*', enabled: false },
    { id: 'hook', name: 'Hook', type: 'webhook', url: 'https://x', events: ['done'], projects: '*' },
  ];
  assert.deepEqual(toolsFor(list, { projectId: 'dataez', role: 'qa', mode: 'change' }).map(i => i.id), ['ado', 'pw']);
  assert.deepEqual(toolsFor(list, { projectId: 'dataez', role: 'qa', mode: 'analyze' }).map(i => i.id), ['pw']); // read-only tasks only get read-only-safe tools
  assert.deepEqual(toolsFor(list, { projectId: 'other', role: 'qa', mode: 'change' }).map(i => i.id), ['ado']);
  const { servers, rules } = mcpFor(toolsFor(list, { projectId: 'dataez', role: 'qa', mode: 'change' }));
  assert.deepEqual(Object.keys(servers), ['ado', 'pw']);
  assert.deepEqual(rules, ['mcp__ado', 'mcp__pw__browser_navigate']);
  assert.match(integrationsPromptBlock(toolsFor(list, { projectId: 'dataez', role: 'qa', mode: 'change' })), /Browser: tools named mcp__pw__… \(only: browser_navigate\)/);
  assert.equal(integrationsPromptBlock([]), '');
  assert.deepEqual(webhooksFor(list, 'done', 'dataez').map(i => i.id), ['hook']);
  assert.deepEqual(webhooksFor(list, 'failed', 'dataez'), []);
});

test('webhook messages in Slack, Teams and JSON form', () => {
  const ctx = { event: 'review', task: { id: 't1', title: 'Add paging', status: 'done', summary: 'Done.', branch: 'agent/backend/x' }, projectName: 'DataEz', roleName: 'Backend Engineer', link: 'http://localhost:4610/#/p/dataez/tasks' };
  assert.match(webhookBody('slack', ctx).text, /^\*Backend Engineer on DataEz is ready for your review: Add paging\*/);
  assert.match(webhookBody('teams', ctx).text, /^\*\*Backend Engineer/);
  const j = webhookBody('json', ctx);
  assert.equal(j.event, 'review');
  assert.equal(j.task.branch, 'agent/backend/x');
  assert.ok(INTEGRATION_PRESETS.some(p => p.key === 'slack') && INTEGRATION_PRESETS.every(p => p.name && p.type));
});

// a tiny MCP server: answers initialize and tools/list over stdio
const FAKE_MCP = `
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
    if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'list_items' }, { name: 'get_item' }] } }) + '\\n');
  }
});`;

test('testing a command MCP server lists its tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mcp-'));
  const file = path.join(dir, 'fake.mjs');
  fs.writeFileSync(file, FAKE_MCP);
  try {
    const ok = await testStdio({ command: process.execPath, args: [file] }, 15000);
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(ok.tools, ['list_items', 'get_item']);
    const missing = await testStdio({ command: 'definitely-not-a-command-xyz', args: [] }, 8000);
    assert.equal(missing.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('testing an HTTP MCP server and sending a webhook', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const m = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, auth: req.headers.authorization, m });
      if (req.url === '/hook') { res.writeHead(200); return res.end('ok'); }
      if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end(); }
      if (m.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })); }
      if (m.method === 'tools/list') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } })}\n\n`); }
      res.writeHead(202); res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await testHttp({ url: `${base}/mcp`, headers: { Authorization: 'Bearer good' } });
    assert.deepEqual(ok, { ok: true, tools: ['search'] });
    const denied = await testHttp({ url: `${base}/mcp`, headers: { Authorization: 'Bearer bad' } });
    assert.match(denied.error, /HTTP 401/);
    const hook = await sendWebhook({ url: `${base}/hook` }, { text: 'hi' });
    assert.equal(hook.ok, true);
    assert.equal(seen.find(s => s.url === '/hook').m.text, 'hi');
  } finally {
    server.close();
  }
});

test('on Windows, npx servers are started through cmd /c', () => {
  const t = [{ id: 'pw', type: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }];
  assert.deepEqual(mcpFor(t, 'win32').servers.pw, { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'], env: {} });
  assert.equal(mcpFor(t, 'linux').servers.pw.command, 'npx');
});
