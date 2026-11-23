// Loads crew.config.json (or crew.config.local.json, which wins) and finds the git repos in
// each project folder. Paths in the config are relative to settings.workspace, which is
// relative to this app's folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoles, setRoles } from './roles.mjs';
import { DEFAULT_LIMITS, cleanLimits } from './limits.mjs';
import { cleanHousekeeping } from './housekeeping.mjs';
import { cleanUi, cleanDesktopAlerts } from './settings.mjs';
import { cleanGraphMode, cleanGraphUpdate } from './graph.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SETTINGS = {
  port: 4610,
  workspace: './workspace',
  model: 'sonnet',
  reportModel: 'sonnet',
  maxConcurrent: 2,
  dailyReport: { enabled: true, at: '09:00', weekdaysOnly: true },
  claudeCommand: 'claude',
  permissionMode: '',
  strictMcp: false,
  // true passes CLAUDE_* / ANTHROPIC_* variables from a parent Claude session through to agents.
  inheritClaudeEnv: false,
  // What happens when a finished task says another role should act next: 'ask' (show it, you
  // press Start), 'auto' (queue it, within limits) or 'off' (agents are not asked for handoffs).
  handoffs: 'ask',
  // extra commands every project's change tasks may run (Settings → Permissions)
  allowCommands: [],
};

export function configFile() {
  const local = path.join(ROOT, 'crew.config.local.json');
  return fs.existsSync(local) ? local : path.join(ROOT, 'crew.config.json');
}

export function loadConfig(file = configFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read ${path.basename(file)}: ${e.message}`);
  }
  const cfg = parseConfig(raw, file);
  setRoles(cfg.roles); // the live role list the rest of the app reads
  return cfg;
}

/** Turn a raw config object into the server's config, listing any problems found. */
export function parseConfig(raw, file = '') {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(raw.settings || {}),
    dailyReport: { ...DEFAULT_SETTINGS.dailyReport, ...((raw.settings || {}).dailyReport || {}) },
  };
  settings.limits = { ...DEFAULT_LIMITS, ...cleanLimits((raw.settings || {}).limits) };
  settings.housekeeping = cleanHousekeeping((raw.settings || {}).housekeeping);
  settings.ui = cleanUi((raw.settings || {}).ui);
  settings.desktopAlerts = cleanDesktopAlerts((raw.settings || {}).desktopAlerts);
  // tools and notifications added in Settings → Integrations
  settings.integrations = Array.isArray((raw.settings || {}).integrations) ? raw.settings.integrations.filter(i => i && i.id && i.type) : [];
  settings.workspacePath = path.resolve(ROOT, settings.workspace);

  const built = buildRoles(raw.roles);
  const problems = [...built.problems];
  const ROLE_IDS = built.roles.map(r => r.id);
  const seen = new Set();
  const projects = (raw.projects || []).map((p, i) => {
    const id = String(p.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`Project #${i + 1}: "id" must be lower-case letters, digits and dashes.`);
    if (seen.has(id)) problems.push(`Project id "${id}" is used twice.`);
    seen.add(id);
    const folder = p.folder || p.path || id;
    const projectPath = path.resolve(settings.workspacePath, folder);
    const roles = {};
    for (const [k, v] of Object.entries(p.roles || {})) {
      if (!ROLE_IDS.includes(k)) problems.push(`Project "${id}": unknown role "${k}" (use ${ROLE_IDS.join(', ')}).`);
      else roles[k] = { repo: v.repo || '', notes: v.notes || '', model: v.model || '', limits: cleanLimits(v.limits) };
    }
    // Roles this project uses; the others get no desk and are left out of the dialogs.
    let activeRoles = Array.isArray(p.activeRoles) ? p.activeRoles.filter(r => ROLE_IDS.includes(r)) : [...ROLE_IDS];
    if (!activeRoles.length) { problems.push(`Project "${id}": "activeRoles" needs at least one role.`); activeRoles = [...ROLE_IDS]; }
    return {
      id,
      name: p.name || id,
      path: projectPath,
      folder,
      stack: p.stack || '',
      context: p.context || '',
      roles,
      activeRoles,
      allowCommands: Array.isArray(p.allowCommands) ? p.allowCommands.map(String) : [],
      limits: cleanLimits(p.limits),
      handoffs: p.handoffs || '',
      // "summary" or "tools" gives agents the repo's graphify knowledge graph; "off" by default
      knowledgeGraph: cleanGraphMode(p.knowledgeGraph),
      // how its repos' graphs are refreshed: "off", "commits" (new commits) or "weekly"
      graphUpdate: cleanGraphUpdate(p.graphUpdate),
      explicitRepos: Array.isArray(p.repos) ? p.repos : null,
      monday: p.monday && p.monday.boardId ? p.monday : null,
      repos: [],
      exists: false,
    };
  });
  for (const p of projects) refreshRepos(p);
  const people = Array.isArray(raw.people) ? raw.people.filter(x => x && x.name) : [];
  return { file, settings, projects, people, problems, roles: built.roles };
}

/** Fill project.repos: the explicit list from the config, or every git repo found in the folder. */
export function refreshRepos(project) {
  project.exists = fs.existsSync(project.path);
  if (project.explicitRepos) {
    project.repos = project.explicitRepos.map(r => {
      const p = path.resolve(project.path, r.path || r.name);
      return { name: r.name || path.basename(p), path: p, exists: isGitRepo(p) };
    });
    return project;
  }
  const repos = [];
  if (project.exists) {
    if (isGitRepo(project.path)) repos.push({ name: path.basename(project.path), path: project.path, exists: true });
    else {
      for (const d1 of safeDirs(project.path)) {
        const p1 = path.join(project.path, d1);
        if (isGitRepo(p1)) { repos.push({ name: d1, path: p1, exists: true }); continue; }
        for (const d2 of safeDirs(p1)) {
          const p2 = path.join(p1, d2);
          if (isGitRepo(p2)) repos.push({ name: `${d1}/${d2}`, path: p2, exists: true });
        }
      }
    }
  }
  project.repos = repos;
  return project;
}

function isGitRepo(p) {
  return fs.existsSync(path.join(p, '.git'));
}

function safeDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);
  } catch {
    return [];
  }
}
