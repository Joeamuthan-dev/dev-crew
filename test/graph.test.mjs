import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graphDigest, findGraph, cleanGraphMode, graphToolRules, writeMcpConfig, graphPromptBlock } from '../lib/graph.mjs';
import { summarizeTrial, compareToBaseline, trialMarkdown } from '../lib/graphtrial.mjs';
import { parseConfig } from '../lib/config.mjs';
import { projectFromForm } from '../lib/configfile.mjs';
import { toolPolicy } from '../lib/claude.mjs';

const REPORT = `# Graph Report - demo

## Summary
- 120 nodes · 300 edges · 4 communities
- Extraction: 90% EXTRACTED

## God Nodes (most connected - your core abstractions)
1. \`AppDbContext\` - 40 edges
2. \`OrderService\` - 22 edges

## Surprising Connections
- something

## Communities (4 total)

### Community 0 - "Orders API"
Cohesion: 0.1
Nodes (12): OrdersController, OrderService, OrderDTO, Total (+8 more)

### Community 1 - "Auth"
Cohesion: 0.2
Nodes (3): AuthController, JwtService, LoginDTO

## Knowledge Gaps
- none
`;

test('graphDigest keeps the summary, the hubs and one line per area', () => {
  const d = graphDigest(REPORT);
  assert.match(d, /^Graph: 120 nodes · 300 edges · 4 communities/);
  assert.match(d, /Most connected: AppDbContext - 40 edges; OrderService - 22 edges/);
  assert.match(d, /- Orders API: OrdersController, OrderService, OrderDTO, Total\n/);
  assert.match(d, /- Auth: AuthController, JwtService, LoginDTO/);
  assert.doesNotMatch(d, /Knowledge Gaps|Cohesion|\+8 more/);
  assert.equal(graphDigest(''), '');
  const short = graphDigest(REPORT, 150);
  assert.ok(short.length < 230);
  assert.match(short, /more areas in graphify-out/);
});

test('findGraph finds graphify-out and the MCP config serves only that graph', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-graph-'));
  try {
    assert.equal(findGraph(dir), null);
    fs.mkdirSync(path.join(dir, 'graphify-out'));
    fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), '{}');
    const g = findGraph(dir);
    assert.ok(g.graph.endsWith('graph.json'));
    assert.equal(g.report, '');
    const file = writeMcpConfig(g.graph, dir, 'graphify-mcp');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(c.mcpServers), ['graphify']);
    assert.deepEqual(c.mcpServers.graphify.args, [g.graph]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('graph tools are read-only graph queries, never the PR tools', () => {
  const rules = graphToolRules();
  assert.ok(rules.includes('mcp__graphify__query_graph'));
  assert.ok(!rules.some(r => /pr/i.test(r.replace('mcp__graphify__', '').replace('graph', ''))));
  // the role policy itself is unchanged: MCP tools are added per run only
  assert.ok(!toolPolicy('analyze').allowed.some(r => r.startsWith('mcp__')));
});

test('the graph option is off unless a project turns it on', () => {
  assert.equal(cleanGraphMode('tools'), 'tools');
  assert.equal(cleanGraphMode('nonsense'), 'off');
  const cfg = parseConfig({ projects: [{ id: 'a' }, { id: 'b', knowledgeGraph: 'summary' }] });
  assert.equal(cfg.projects[0].knowledgeGraph, 'off');
  assert.equal(cfg.projects[1].knowledgeGraph, 'summary');
  assert.equal(projectFromForm({ id: 'a', knowledgeGraph: 'tools' }).knowledgeGraph, 'tools');
  assert.equal(projectFromForm({ id: 'a', knowledgeGraph: 'off' }, { knowledgeGraph: 'tools' }).knowledgeGraph, undefined);
  assert.equal(graphPromptBlock('off'), '');
  assert.match(graphPromptBlock('tools', { builtAt: Date.UTC(2026, 10, 21) }), /built 2026-11-21[\s\S]*query_graph/);
});

const run = (question, variant, cost, input, over = {}) => ({
  question, variant, ok: true, costUsd: cost, turns: 10, wallMs: 60000,
  tokens: { input, output: 500, cacheRead: input * 2, cacheWrite: 0 }, tools: { Grep: 6, Read: 4 }, answer: '', ...over,
});

test('summarizeTrial and compareToBaseline compare medians with no graph', () => {
  const runs = [
    run(0, 'off', 0.4, 1000), run(1, 'off', 0.6, 2000),
    run(0, 'tools', 0.2, 500, { tools: { Read: 3, mcp__graphify__query_graph: 2 } }), run(1, 'tools', 0.4, 1000, { tools: { Read: 3, mcp__graphify__query_graph: 1 } }),
    { question: 2, variant: 'tools', ok: false, error: 'x', costUsd: 0.05, turns: 1, wallMs: 1, tokens: {}, tools: {} },
  ];
  const rows = summarizeTrial(runs);
  const tools = rows.find(r => r.variant === 'tools');
  assert.equal(tools.runs, 2);
  assert.equal(tools.failed, 1);
  assert.ok(Math.abs(tools.medianCostUsd - 0.3) < 1e-9);
  assert.equal(tools.medianSearches, 0);
  assert.equal(tools.medianGraphCalls, 1.5);
  const d = compareToBaseline(rows)[0];
  assert.ok(Math.abs(d.cost - -0.4) < 1e-9);
  assert.ok(Math.abs(d.promptTokens - -0.5) < 1e-9);
  const md = trialMarkdown({ project: 'P', repo: 'R', model: 'sonnet', questions: ['a', 'b', 'c'], runs, startedAt: 0 });
  assert.match(md, /\*\*tools:\*\* cost -40%, prompt tokens -50%/);
  assert.match(md, /failed: x/);
});
