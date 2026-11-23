// Knowledge-graph context for agents, from graphify (https://pypi.org/project/graphifyy/).
// A project opts in with "knowledgeGraph": "summary" (a short digest of the repo's
// graphify-out/GRAPH_REPORT.md in the system prompt) or "tools" (the graph served to the agent
// over MCP by graphify-mcp, read-only graph tools only). "off" is the default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GRAPH_MODES = ['off', 'summary', 'tools'];

// Read-only graph tools. graphify-mcp also has PR tools (they call GitHub); those stay off.
export const GRAPH_TOOLS = ['query_graph', 'get_node', 'get_section', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path'];
export const graphToolRules = () => GRAPH_TOOLS.map(t => `mcp__graphify__${t}`);

export const cleanGraphMode = v => (GRAPH_MODES.includes(v) ? v : 'off');

/** The graph files for a folder (a repo), or null when graphify has not been run there. */
export function findGraph(dir) {
  if (!dir) return null;
  const out = path.join(dir, 'graphify-out');
  const report = path.join(out, 'GRAPH_REPORT.md');
  const graph = path.join(out, 'graph.json');
  if (!fs.existsSync(graph) && !fs.existsSync(report)) return null;
  let builtAt = 0;
  try { builtAt = fs.statSync(fs.existsSync(graph) ? graph : report).mtimeMs; } catch { /* unknown */ }
  return { dir: out, report: fs.existsSync(report) ? report : '', graph: fs.existsSync(graph) ? graph : '', builtAt };
}

/** Pull one "## Heading" section (without its heading) out of a Markdown report. */
function section(md, title) {
  const re = new RegExp(`^##\\s+${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi');
  const m = re.exec(md);
  return m ? m[1].trim() : '';
}

/**
 * A compact digest of GRAPH_REPORT.md for the system prompt: the summary line, the most
 * connected nodes, and one line per community (its name and its main members).
 */
export function graphDigest(md, maxChars = 6000) {
  if (!md) return '';
  const summary = section(md, 'Summary').split('\n').filter(l => /nodes|edges|communities/i.test(l)).slice(0, 1).join(' ');
  const gods = section(md, 'God Nodes').split('\n').filter(l => /^\d+\./.test(l.trim())).slice(0, 10)
    .map(l => l.replace(/^\s*\d+\.\s*/, '').replace(/`/g, '')).join('; ');
  const comm = [];
  for (const m of section(md, 'Communities').matchAll(/###\s+Community\s+\d+\s+-\s+"([^"]+)"[\s\S]*?Nodes\s*\(\d+\):\s*([^\n]+)/g)) {
    comm.push(`- ${m[1]}: ${m[2].replace(/\s*\(\+\d+ more\)/, '').split(',').slice(0, 6).map(s => s.trim()).join(', ')}`);
  }
  let text = [summary && `Graph: ${summary.replace(/^-\s*/, '')}`, gods && `Most connected: ${gods}`, comm.length ? `Areas of the code (community: main members):\n${comm.join('\n')}` : '']
    .filter(Boolean).join('\n');
  if (text.length > maxChars) text = text.slice(0, text.lastIndexOf('\n', maxChars)) + '\n- … (more areas in graphify-out/GRAPH_REPORT.md)';
  return text;
}

/** The graphify MCP server: on PATH, or where uv installs tools on Windows. */
export function graphifyMcpCommand(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  const local = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'graphify-mcp.exe' : 'graphify-mcp');
  return home && fs.existsSync(local) ? local : 'graphify-mcp';
}

/** Write an MCP config that serves this graph read-only; returns the file path. */
export function writeMcpConfig(graphJson, tmpDir = os.tmpdir(), command = graphifyMcpCommand()) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `mcp-graph-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { graphify: { type: 'stdio', command, args: [graphJson] } } }, null, 2));
  return file;
}

/** What to tell an agent about the graph it has. */
export function graphPromptBlock(mode, { digest = '', builtAt = 0 } = {}) {
  const age = builtAt ? ` (built ${new Date(builtAt).toISOString().slice(0, 10)}; code changed since then is not in it)` : '';
  if (mode === 'tools') {
    return `Knowledge graph: a graph of this repo's code (classes, files, imports, calls, docs) is available through the graphify tools${age}. Before searching files, use query_graph (with a short question) or get_node / get_neighbors / shortest_path to find which classes and files matter, then open only those with Read. Trust the files over the graph when they disagree.`;
  }
  if (mode === 'summary' && digest) {
    return `Knowledge graph digest of this repo${age}. Use it to decide where to look first; confirm in the files.\n${digest}`;
  }
  return '';
}

/* ---------------- keeping the graph current, and showing it ---------------- */

// How a project's graph is refreshed: never by itself, when the checked-out branch has new
// commits (checked every half hour), or once a week. A button can always update it by hand.
export const GRAPH_UPDATE_MODES = ['off', 'commits', 'weekly'];
export const cleanGraphUpdate = v => (GRAPH_UPDATE_MODES.includes(v) ? v : 'off');
const WEEK = 7 * 864e5;

/** The numbers at the top of GRAPH_REPORT.md: nodes, edges, communities, files. */
export function graphStats(md) {
  const num = re => { const m = re.exec(md || ''); return m ? Number(m[1].replace(/[,\s]/g, '')) : 0; };
  return {
    nodes: num(/([\d,]+)\s+nodes/),
    edges: num(/([\d,]+)\s+edges/),
    communities: num(/([\d,]+)\s+communities/),
    files: num(/([\d,]+)\s+files/),
  };
}

/**
 * Whether an automatic update is due. lastCommitAt is the newest commit on the checked-out
 * branch (ms); builtAt is when the graph was last written.
 */
export function graphUpdateDue(mode, { builtAt = 0, lastCommitAt = 0, checkedAt = 0, now = Date.now() } = {}) {
  if (!builtAt) return false; // the first graph is built with graphify itself, not here
  // checkedAt: the last update that found nothing to rebuild (a commit that changed no code)
  if (mode === 'commits') return lastCommitAt > Math.max(builtAt, checkedAt) + 1000;
  if (mode === 'weekly') return now - builtAt >= WEEK;
  return false;
}

/** The graphify command: on PATH, or where uv installs tools. */
export function graphifyCommand(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  const local = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  return home && fs.existsSync(local) ? local : 'graphify';
}
