// Editing crew.config.local.json from the dashboard, safely: every change is validated before it
// is written, the previous file is backed up, and the write is atomic (temp file + rename), so a
// crash can never leave a half-written config.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, parseConfig } from './config.mjs';
import { ROLE_IDS } from './roles.mjs';
import { cleanLimits } from './limits.mjs';
import { HANDOFF_POLICIES } from './handoffs.mjs';
import { GRAPH_MODES, GRAPH_UPDATE_MODES } from './graph.mjs';

export const LOCAL = path.join(ROOT, 'crew.config.local.json');
const SHIPPED = path.join(ROOT, 'crew.config.json');
const BACKUPS = path.join(ROOT, 'data', 'config-backups');
const KEEP_BACKUPS = 10;

/**
 * The raw local config. Without one yet, start from the shipped settings with no projects or
 * people, so saving the first project does not also adopt the demo projects.
 */
export function readRaw() {
  if (fs.existsSync(LOCAL)) return JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
  let shipped = {};
  try { shipped = JSON.parse(fs.readFileSync(SHIPPED, 'utf8')); } catch { /* none */ }
  return { settings: shipped.settings || {}, projects: [], people: [] };
}

/** Validate, back up the current file, then write atomically. Throws with the problems found. */
export function writeRaw(raw) {
  const check = parseConfig(raw, LOCAL);
  if (check.problems.length) throw new Error(check.problems.join(' '));
  if (fs.existsSync(LOCAL)) {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(LOCAL, path.join(BACKUPS, `crew.config.local.${stamp}.json`));
    const old = fs.readdirSync(BACKUPS).filter(f => f.startsWith('crew.config.local.')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUPS, f), { force: true });
  }
  const tmp = `${LOCAL}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, LOCAL);
}

const str = (v, max = 4000) => String(v == null ? '' : v).trim().slice(0, max);

/** A project folder as written in the config: relative to the workspace when it is inside it. */
export function folderForConfig(folder, workspacePath) {
  const abs = path.resolve(workspacePath, folder);
  const rel = path.relative(workspacePath, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : abs.replace(/\\/g, '/');
}

/**
 * Merge the editor's form into a raw project. Fields the editor does not show (monday, repos,
 * anything added by hand) are kept from the existing project.
 */
export function projectFromForm(form, existing = {}, workspacePath = ROOT) {
  const id = str(form.id, 40).toLowerCase();
  const activeRoles = (Array.isArray(form.activeRoles) ? form.activeRoles : []).filter(r => ROLE_IDS.includes(r));
  const roles = {};
  for (const r of ROLE_IDS) {
    const f = (form.roles || {})[r] || {};
    const prev = (existing.roles || {})[r] || {};
    const entry = { ...prev };
    for (const k of ['repo', 'notes', 'model']) {
      const v = str(f[k], k === 'notes' ? 4000 : 200);
      if (v) entry[k] = v; else delete entry[k];
    }
    const lim = cleanLimits(f.limits);
    if (Object.keys(lim).length) entry.limits = lim; else delete entry.limits;
    if (Object.keys(entry).length) roles[r] = entry;
  }
  const out = {
    ...existing,
    id,
    name: str(form.name, 80) || id,
    folder: folderForConfig(str(form.folder, 1000) || id, workspacePath),
    stack: str(form.stack, 2000),
    context: str(form.context, 4000),
    activeRoles,
    roles,
    allowCommands: (Array.isArray(form.allowCommands) ? form.allowCommands : String(form.allowCommands || '').split('\n'))
      .map(s => str(s, 200)).filter(Boolean),
  };
  delete out.path; // "folder" is the one we write
  if (HANDOFF_POLICIES.includes(form.handoffs)) out.handoffs = form.handoffs; else delete out.handoffs;
  // the monday.com board picked in Edit project ('' disconnects the board)
  if (form.mondayBoardId !== undefined) {
    const id = String(form.mondayBoardId || '').trim();
    if (/^\d{1,20}$/.test(id)) out.monday = { ...(existing.monday || {}), boardId: id };
    else if (!id) delete out.monday;
  }
  if (GRAPH_MODES.includes(form.knowledgeGraph) && form.knowledgeGraph !== 'off') out.knowledgeGraph = form.knowledgeGraph; else delete out.knowledgeGraph;
  if (form.graphUpdate !== undefined) {
    if (GRAPH_UPDATE_MODES.includes(form.graphUpdate) && form.graphUpdate !== 'off') out.graphUpdate = form.graphUpdate; else delete out.graphUpdate;
  }
  const lim = cleanLimits(form.limits);
  if (Object.keys(lim).length) out.limits = lim; else delete out.limits;
  if (!out.allowCommands.length) delete out.allowCommands;
  if (activeRoles.length === ROLE_IDS.length) delete out.activeRoles; // all roles: the default
  return out;
}

/** Insert or replace a project (by its old id, so the id can be renamed). */
export function upsertProject(raw, project, oldId = project.id) {
  const list = Array.isArray(raw.projects) ? raw.projects : [];
  const i = list.findIndex(p => p.id === oldId);
  if (oldId !== project.id && list.some(p => p.id === project.id)) throw new Error(`A project with id "${project.id}" already exists.`);
  if (i >= 0) list[i] = project; else if (list.some(p => p.id === project.id)) throw new Error(`A project with id "${project.id}" already exists.`); else list.push(project);
  return { ...raw, projects: list };
}

export function removeProject(raw, id) {
  return { ...raw, projects: (raw.projects || []).filter(p => p.id !== id) };
}

/** Clean the people list from the editor. */
export function peopleFromForm(list) {
  const arr = (v, max = 30) => (Array.isArray(v) ? v : String(v || '').split(',')).map(s => str(s, 80)).filter(Boolean).slice(0, max);
  return (Array.isArray(list) ? list : []).map(p => {
    const out = { name: str(p.name, 80) };
    for (const k of ['title', 'company', 'email', 'teams', 'hours']) { const v = str(p[k], 200); if (v) out[k] = v; }
    if (p.contractor === true || p.contractor === 'true' || p.contractor === 'on') out.contractor = true;
    const projects = arr(p.projects);
    const roles = arr(p.roles).filter(r => ROLE_IDS.includes(r));
    const skills = arr(p.skills);
    if (projects.length) out.projects = projects;
    if (roles.length) out.roles = roles;
    if (skills.length) out.skills = skills;
    return out;
  }).filter(p => p.name);
}
