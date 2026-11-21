// Does a knowledge graph save tokens? Runs the same read-only questions on one repo with no
// graph, with the graph digest in the prompt, and with graph tools, then writes a comparison.
//
//   node scripts/graph-trial.mjs --project dataez [--repo DataEzapi] [--variants off,summary,tools]
//        [--model sonnet] [--budget 1.5] [--max-total 10] [--questions questions.json] [--only 1]
//
// Every run is a paid Claude Code session (read-only tools). --budget caps each run, --max-total
// stops the trial once that much has been spent. Results go to data/graph-trial/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../lib/config.mjs';
import { runClaude, claudeFeatures } from '../lib/claude.mjs';
import { taskSystemPrompt, taskPrompt } from '../lib/prompts.mjs';
import { findGraph, graphDigest, graphPromptBlock, writeMcpConfig, graphToolRules, GRAPH_MODES } from '../lib/graph.mjs';
import { DEFAULT_QUESTIONS, trialMarkdown, promptTokens } from '../lib/graphtrial.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const cfg = loadConfig();
const project = cfg.projects.find(p => p.id === arg('project', '')) || cfg.projects.find(p => p.repos.some(r => findGraph(r.path)));
if (!project) { console.error('No project with a graphify-out folder. Pass --project <id>.'); process.exit(1); }
const repo = project.repos.find(r => r.name === arg('repo', '')) || project.repos.find(r => findGraph(r.path));
const graph = repo && findGraph(repo.path);
if (!graph) { console.error(`No graphify-out folder in ${repo ? repo.path : project.path}. Run graphify there first.`); process.exit(1); }

const variants = arg('variants', 'off,summary,tools').split(',').filter(v => GRAPH_MODES.includes(v));
const model = arg('model', cfg.settings.model || 'sonnet');
const budget = Number(arg('budget', '1.5'));
const maxTotal = Number(arg('max-total', '10'));
let questions = DEFAULT_QUESTIONS;
if (arg('questions', '')) questions = JSON.parse(fs.readFileSync(arg('questions', ''), 'utf8'));
if (arg('only', '')) questions = questions.slice(0, Number(arg('only', '')));
if (arg('ask', '')) questions = [arg('ask', '')];

const OUT = path.join(ROOT, 'data', 'graph-trial');
const TMP = path.join(ROOT, 'data', 'tmp');
fs.mkdirSync(OUT, { recursive: true });
const startedAt = Date.now();
const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
const digest = graph.report ? graphDigest(fs.readFileSync(graph.report, 'utf8')) : '';
const features = await claudeFeatures(cfg.settings.claudeCommand);
if (!features.found) { console.error('Claude Code was not found.'); process.exit(1); }

console.log(`Trial on ${project.name} / ${repo.name}: ${questions.length} question(s) × ${variants.join(', ')} · ${model} · $${budget} per run, stop at $${maxTotal}`);
const runs = [];
let spent = 0;
const save = () => {
  const data = { project: project.name, repo: repo.name, model, questions, variants, startedAt, runs };
  fs.writeFileSync(path.join(OUT, `${stamp}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(OUT, `${stamp}.md`), trialMarkdown(data));
};

outer:
for (let qi = 0; qi < questions.length; qi++) {
  // rotate the order per question, so no variant always runs first (prompt-cache warmth)
  const order = variants.map((_, k) => variants[(k + qi) % variants.length]);
  for (const variant of order) {
    if (spent >= maxTotal) { console.log(`Stopped: $${spent.toFixed(2)} spent, the --max-total limit.`); break outer; }
    let block = '';
    let mcp = '';
    let extraTools = [];
    if (variant === 'summary') block = graphPromptBlock('summary', { digest, builtAt: graph.builtAt });
    if (variant === 'tools') {
      mcp = writeMcpConfig(graph.graph, TMP);
      extraTools = graphToolRules();
      block = graphPromptBlock('tools', { builtAt: graph.builtAt });
    }
    const tools = {};
    const init = {};
    const t0 = Date.now();
    process.stdout.write(`Q${qi + 1} ${variant.padEnd(7)} … `);
    const run = runClaude({
      command: cfg.settings.claudeCommand,
      cwd: repo.path,
      prompt: taskPrompt({ title: questions[qi] }),
      systemPrompt: taskSystemPrompt(project, 'architect', 'analyze', { cwd: repo.path, handoffs: 'off', graph: block }),
      mode: 'analyze',
      model,
      mcpConfig: mcp,
      extraTools,
      strictMcp: true, // only the graph's server, never the owner's other MCP servers
      inheritEnv: cfg.settings.inheritClaudeEnv,
      maxBudgetUsd: budget,
      tmpDir: TMP,
      onEvent: ev => {
        // what the session started with: did the graph server connect, which graph tools it saw
        if (ev.type === 'system' && ev.subtype === 'init') {
          init.mcp = (ev.mcp_servers || []).map(s => `${s.name}:${s.status}`);
          init.graphTools = (ev.tools || []).filter(n => n.startsWith('mcp__graphify__')).length;
        }
        if (ev.type !== 'assistant' || !ev.message || !Array.isArray(ev.message.content)) return;
        for (const c of ev.message.content) if (c.type === 'tool_use') tools[c.name] = (tools[c.name] || 0) + 1;
      },
    });
    const res = await run.done;
    if (mcp) fs.rmSync(mcp, { force: true });
    spent += res.costUsd;
    const row = {
      question: qi, variant, ok: res.ok, error: res.ok ? '' : res.error, costUsd: res.costUsd, turns: res.turns,
      tokens: res.stats.tokens, wallMs: Date.now() - t0, tools, init, denials: res.denials.map(d => d.tool_name), answer: res.result,
    };
    if (variant === 'tools' && !init.graphTools) console.log(`(graph tools missing at start: ${JSON.stringify(init)})`);
    runs.push(row);
    console.log(res.ok
      ? `$${res.costUsd.toFixed(3)} · ${res.turns} turns · ${promptTokens(row.tokens).toLocaleString()} prompt tokens · ${Math.round(row.wallMs / 1000)}s · tools ${JSON.stringify(tools)}`
      : `failed: ${res.error.slice(0, 200)}`);
    save();
  }
}
save();
console.log(`\nDone: $${spent.toFixed(2)} spent. Report: ${path.join(OUT, `${stamp}.md`)}`);
