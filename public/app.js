// Dev Crew dashboard. No framework: state from /api/state, live updates from /api/events,
// views are re-rendered from that state.

import { detectAlerts, ALERT_EVENTS, ALERT_DEFAULTS } from './alerts.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = null;
const activity = {};          // task id -> last thing the agent did
let drawer = null;            // { kind: 'task'|'report', id }
const ui = { taskFilter: 'all', roleFilter: '' };
const feed = [];              // latest agent activity across all projects, newest first
let office = null;            // the 3D office, created on first visit
let officeEl = null;

/* ---------------- data ---------------- */

async function api(url, { method = 'GET', body } = {}) {
  // X-Dev-Crew marks the request as coming from this dashboard; the server refuses state
  // changes without it (other sites cannot send custom headers to localhost).
  const headers = { 'x-dev-crew': '1', ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function load() {
  S = await api('/api/state');
  applyUi();
  render();
  if (drawer) refreshDrawer();
}

/** Appearance from the Settings page: theme, motion and 3D quality (the 3D office reads them). */
let officeQuality = null;
function applyUi() {
  const ui = (S && S.settings.ui) || { theme: 'system', motion: 'full', quality: 'high', officeView: '3d' };
  globalThis.devcrewUi = ui;
  setTheme(ui.theme === 'system' ? '' : ui.theme);
  document.documentElement.dataset.motion = ui.motion;
  // A different 3D quality needs a new renderer: drop the office so the next visit rebuilds it.
  if (officeQuality && officeQuality !== ui.quality && office && office.destroy) {
    office.destroy();
    office = null;
    officeEl = null;
  }
  officeQuality = ui.quality;
}

function upsert(list, item) {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.unshift(item);
}

function connect() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onopen = () => { if (dropped) { dropped = false; load(); } };
  es.onerror = () => { dropped = true; };
  es.addEventListener('task', e => {
    const t = JSON.parse(e.data);
    const prev = S.tasks.find(x => x.id === t.id);
    upsert(S.tasks, t);
    raiseAlerts(prev, t);
    if (t.status !== 'running') delete activity[t.id];
    schedule();
    if (drawer && drawer.id === t.id) refreshDrawer();
  });
  es.addEventListener('task-removed', e => {
    const { id } = JSON.parse(e.data);
    S.tasks = S.tasks.filter(t => t.id !== id);
    if (drawer && drawer.id === id) closeDrawer();
    schedule();
  });
  es.addEventListener('report', e => {
    const r = JSON.parse(e.data);
    upsert(S.reports, r);
    schedule();
    if (drawer && drawer.id === r.id) refreshDrawer();
  });
  es.addEventListener('log', e => {
    const l = JSON.parse(e.data);
    if (l.kind === 'tool' || l.kind === 'say') {
      activity[l.id] = l.text.split('\n')[0];
      const t = S.tasks.find(x => x.id === l.id);
      if (t) { feed.unshift({ at: l.at, task: t.id, projectId: t.projectId, role: t.role, text: activity[l.id] }); feed.length = Math.min(feed.length, 40); }
      schedule();
    }
    if (drawer && drawer.id === l.id) appendLog([l]);
  });
  // Queue ETAs and today's spend, re-sent whenever a task or report changes (and every 30s).
  es.addEventListener('queue', e => {
    const q = JSON.parse(e.data);
    S.etas = q.etas;
    S.spend = q.spend;
    schedule();
    if (drawer) refreshDrawer();
  });
  es.addEventListener('reload', () => load());
  // a graph update started or finished: refresh the Graph tab's status, and its view when done
  es.addEventListener('graph', e => {
    const g = JSON.parse(e.data);
    const page = $('#graphPage');
    if (!page || page.dataset.pid !== g.projectId) return;
    loadGraph(g.projectId, { reloadView: !g.running && !g.queued && g.ok && g.repo === graphUi.repo });
  });
  es.addEventListener('monday', () => load());
}

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

/* ---------------- helpers ---------------- */

const roleOf = id => S.roles.find(r => r.id === id) || { id, name: id, short: id, color: '#888' };
const projOf = id => S.projects.find(p => p.id === id);
const tasksOf = pid => S.tasks.filter(t => t.projectId === pid);
const latestReport = pid => S.reports.find(r => r.projectId === pid && r.status === 'done');
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();
const needsReview = t => t.mode === 'change' && t.status === 'done' && !t.cleaned && t.git && t.git.commits.length > 0;
const taskOf = id => S.tasks.find(x => x.id === id);
/** The roles a project uses (all of them when it does not say). */
const crewRoles = p => S.roles.filter(r => !p || !p.activeRoles || p.activeRoles.includes(r.id));
/** Tasks this one still waits for (not done yet). */
const waitingOn = t => (t.dependsOn || []).map(taskOf).filter(d => d && d.status !== 'done');
/** Tasks that started from this one (handoffs and plan steps). */
const childrenOf = t => S.tasks.filter(x => x.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt);

function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
const fmtTime = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const money = n => (n ? `$${n.toFixed(2)}` : '');

/** 90000 -> "2m", 5400000 -> "1h 30m". */
function dur(ms) {
  const m = Math.max(1, Math.round((ms || 0) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** "starts in 4m", "~3m left", "waiting: daily limit" for a queued or running task. */
function etaText(t) {
  const e = S.etas && S.etas[t.id];
  const now = Date.now();
  if (t.status === 'queued') {
    if (!e) return S.spend && S.spend.paused ? 'waiting: daily spend limit reached' : '';
    return e.start - now < 60000 ? `starts now · ~${dur(e.end - e.start)}` : `starts in ${dur(e.start - now)} · ~${dur(e.end - e.start)}`;
  }
  if (t.status === 'running' && e) return e.end - now <= 60000 ? 'finishing soon' : `~${dur(e.end - now)} left`;
  return '';
}

/** "4–7m · $0.30–$0.60" from an estimate's 25th–75th percentiles. */
function estRange(est) {
  const c = est.costUsd;
  const cost = c.p75 < 0.01 ? '<$0.01' : `$${c.p25.toFixed(2)}–$${c.p75.toFixed(2)}`;
  return `${dur(est.wallMs.p25)}–${dur(est.wallMs.p75)} · ${cost}`;
}

function roleChip(roleId, cls = '') {
  const r = roleOf(roleId);
  return `<span class="role-chip ${cls}" style="--rc:${r.color}" title="${esc(r.name)}">${esc(r.short)}</span>`;
}

function statusPill(t) {
  if (t.status === 'running') return '<span class="pill blue">Working</span>';
  if (t.status === 'queued') return '<span class="pill blue">Queued</span>';
  if (t.status === 'failed') return '<span class="pill red">Failed</span>';
  if (t.status === 'stopped') return `<span class="pill amber" title="${esc(t.error || '')}">Stopped · ${t.stopReason === 'budget' ? 'cost limit' : 'time limit'}</span>`;
  if (t.status === 'blocked') return `<span class="pill red" title="${esc(t.error || '')}">Blocked</span>`;
  if (t.status === 'queued' && waitingOn(t).length) return `<span class="pill" title="Starts when the tasks it depends on are done">Waiting</span>`;
  if (t.status === 'done' && t.noChanges) return '<span class="pill amber" title="Finished without a single commit">No changes</span>';
  if (t.status === 'done' && t.origin !== 'plan' && (t.handoffs || []).some(h => h.status === 'proposed')) return '<span class="pill amber">Handoff</span>';
  if (t.status === 'done' && t.plan && t.plan.status === 'proposed') return '<span class="pill amber">Plan ready</span>';
  if (t.status === 'cancelled') return '<span class="pill">Cancelled</span>';
  if (needsReview(t)) return '<span class="pill amber">Review</span>';
  return '<span class="pill green">Done</span>';
}

function healthPill(r) {
  if (!r) return '<span class="pill">No stand-up yet</span>';
  const label = { green: 'On track', amber: 'Watch', red: 'At risk' }[r.health] || 'Reported';
  const days = standupAgeDays(r);
  // an old stand-up is shown as such, so "At risk" from two days ago doesn't read as today's news
  return days > 0
    ? `<span class="pill ${r.health} stale" title="From the ${esc(r.date)} stand-up; run a new one for today's view">${label} · ${days === 1 ? 'yesterday' : `${days} days ago`}</span>`
    : `<span class="pill ${r.health}">${label}</span>`;
}

/** Whole days between a stand-up's date and today (0 for today's). */
function standupAgeDays(r) {
  if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return 0;
  const [y, m, d] = r.date.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - then) / 864e5));
}

/** Long text in three lines, with a "More" button when it doesn't fit. */
/** "25k new + 1.3M cached tokens": cached prompt text is cheap, so the two are shown apart. */
function tokenWords(tk) {
  const k = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  const fresh = (tk.input || 0) + (tk.output || 0) + (tk.cacheWrite || 0);
  return `<span title="${(tk.input || 0).toLocaleString()} input, ${(tk.output || 0).toLocaleString()} output, ${(tk.cacheWrite || 0).toLocaleString()} written to cache, ${(tk.cacheRead || 0).toLocaleString()} read from cache (about a tenth of the price)">${k(fresh)} new + ${k(tk.cacheRead || 0)} cached tokens</span>`;
}

function clampText(text, cls) {
  if (!text) return '';
  const long = text.length > 220;
  return `<div class="${cls} clamp${long ? ' is-long' : ''}">${esc(text)}</div>${long ? '<button class="linkish clamp-more" data-unclamp>More</button>' : ''}`;
}

/** The Live panel when nothing is running: today's finished work, newest first. */
function recentFeed() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const done = S.tasks.filter(t => t.endedAt && t.endedAt >= start.getTime() && ['done', 'failed', 'stopped'].includes(t.status))
    .sort((a, b) => b.endedAt - a.endedAt).slice(0, 5);
  if (!done.length) return '';
  const word = t => (t.status === 'failed' ? 'failed' : t.status === 'stopped' ? 'stopped at a limit' : t.noChanges ? 'finished, no changes' : needsReview(t) ? 'ready for review' : 'finished');
  return '<li class="f-head">Earlier today</li>' + done.map(t => `<li data-task="${t.id}" tabindex="0" role="button">${roleChip(t.role)}<span class="f-text"><b>${esc((projOf(t.projectId) || {}).name || '')}</b> ${esc(t.title)} · ${word(t)}</span><time>${ago(t.endedAt)}</time></li>`).join('');
}

function toast(msg, err = false) {
  const el = $('#toast');
  el.setAttribute('role', err ? 'alert' : 'status');
  el.textContent = msg;
  el.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.className = 'toast'; }, err ? 5000 : 2600);
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));
}

/* ---------------- markdown (small, escapes everything first) ---------------- */

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let html = '';
  let i = 0;
  const isBlock = l => /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\|)/.test(l) || /^\s*(---+|\*\*\*+)\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const lvl = Math.min(4, Math.max(2, h[1].length));
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { html += '<hr>'; i++; continue; }
    if (/^\s*[-*+]\s/.test(l) || /^\s*\d+[.)]\s/.test(l)) {
      const ordered = /^\s*\d+[.)]\s/.test(l);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i].replace(re, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      html += ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`;
      continue;
    }
    if (l.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      html += `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      continue;
    }
    const para = [l];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) para.push(lines[i++]);
    html += `<p>${para.map(inline).join('<br>')}</p>`;
  }
  return `<div class="md">${html}</div>`;
}

/* ---------------- motion helpers ---------------- */

/** Movement is allowed: Settings → Motion is Full and the system does not ask for less. */
const motionOn = () => !['off', 'reduced'].includes(document.documentElement.dataset.motion)
  && !matchMedia('(prefers-reduced-motion: reduce)').matches;

// Numbers count to their new value when they change (not on first sight). Each has a key, so it
// is recognised again after a live update redraws the page.
const NUM_FMT = {
  int: v => Math.round(v).toLocaleString(),
  usd: v => usd(v),
  usd2: v => '$' + v.toFixed(2),
  pct: v => pct(v),
};
const numSeen = new Map();
function num(value, key, fmt = 'int') {
  const v = Number(value) || 0;
  return `<span data-num="${v}" data-num-key="${esc(key)}" data-fmt="${fmt}">${NUM_FMT[fmt](v)}</span>`;
}
function animateNumbers(root = document) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-num-key]')) {
    const key = el.dataset.numKey;
    const to = Number(el.dataset.num);
    const prev = numSeen.get(key);
    if (prev && prev.raf) cancelAnimationFrame(prev.raf);
    const entry = { value: to, raf: 0 };
    numSeen.set(key, entry);
    if (!prev || prev.value === to || !motionOn()) continue;
    const from = prev.value;
    const fmt = NUM_FMT[el.dataset.fmt] || NUM_FMT.int;
    const final = el.textContent;
    const t0 = performance.now();
    const step = now => {
      if (!el.isConnected) return;
      const k = Math.min(1, (now - t0) / 650);
      el.textContent = k < 1 ? fmt(from + (to - from) * (1 - Math.pow(1 - k, 3))) : final;
      entry.raf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    entry.raf = requestAnimationFrame(step);
  }
}

// A short entrance when the page changes, not on live updates of the same page.
let shownPage = '';
function pageEnter(main, key) {
  if (key === shownPage) return;
  shownPage = key;
  main.classList.remove('page-enter');
  if (!motionOn()) return;
  void main.offsetWidth; // restart the animation
  main.classList.add('page-enter');
}

/* ---------------- layout ---------------- */

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  if (parts[0] === 'p' && parts[1]) return { view: 'project', id: parts[1], tab: parts[2] || 'crew' };
  if (parts[0] === 'today') return { view: 'today' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'costs') return { view: 'costs' };
  return { view: 'office' };
}

function render() {
  if (!S) return;
  renderTop();
  renderSidebar();
  const r = route();
  const main = $('#main');
  const twoD = ((S.settings.ui || {}).officeView) === '2d';
  animateNumbers($('#topStats'));
  if (r.view === 'office' && !twoD) { shownPage = 'office3d'; main.classList.remove('page-enter'); return renderOffice(); }
  pageEnter(main, [r.view, r.id || '', r.tab || ''].join('/'));
  main.classList.remove('full');
  closeAgentCard();
  if (office && office.stop) office.stop();
  if (officeEl && main.contains(officeEl)) main.replaceChildren();
  // The Settings page is drawn once per visit, so live updates never wipe a half-edited form.
  if (r.view === 'settings') { if (!$('#settingsPage')) renderSettings(main); return; }
  // Drawn on arrival and when a filter changes, not on every live update (hover state stays put).
  if (r.view === 'costs') { if (!$('#costsPage')) renderCosts(main); return; }
  const scroll = window.scrollY;
  if (r.view === 'project' && projOf(r.id) && r.tab === 'graph') {
    const page = $('#graphPage');
    if (!page || page.dataset.pid !== r.id) { main.innerHTML = projectView(projOf(r.id), 'graph'); loadGraph(r.id); }
    return;
  }
  // Drawn once per visit (so a half-typed lesson survives live updates).
  if (r.view === 'project' && projOf(r.id) && r.tab === 'lessons') {
    const page = $('#lessonsPage');
    if (!page || page.dataset.pid !== r.id) { main.innerHTML = projectView(projOf(r.id), 'lessons'); loadLessons(r.id); }
    return;
  }
  if (r.view === 'project' && projOf(r.id)) main.innerHTML = projectView(projOf(r.id), r.tab);
  else if (r.view === 'office') main.innerHTML = office2dView();
  else main.innerHTML = todayView();
  window.scrollTo(0, scroll);
  animateNumbers(main);
}

function renderTop() {
  const running = S.tasks.filter(t => t.status === 'running').length + S.reports.filter(r => r.status === 'running').length;
  const queued = S.tasks.filter(t => t.status === 'queued').length + S.reports.filter(r => r.status === 'queued').length;
  const review = S.tasks.filter(needsReview).length;
  const sp = S.spend || { today: 0, daily: 0, state: 'ok' };
  const spendTitle = sp.paused
    ? 'Daily spend limit reached: queued runs wait until tomorrow or until the limit is raised'
    : 'API-equivalent cost reported by Claude Code, against your daily limit';
  $('#topStats').innerHTML = `
    <span><b>${num(running, 'top-running')}</b> working</span>
    <span><b>${num(queued, 'top-queued')}</b> queued</span>
    <span><b>${num(review, 'top-review')}</b> to review</span>
    <span class="spend ${sp.state}" title="${spendTitle}"><b>${num(sp.today, 'top-spend', 'usd2')}</b>${sp.daily ? ` / $${sp.daily}` : ''} today${sp.paused ? ' · paused' : ''}</span>`;
}

function renderSidebar() {
  const r = route();
  const items = S.projects.map(p => {
    const rep = latestReport(p.id);
    const live = tasksOf(p.id).filter(t => t.status === 'running' || t.status === 'queued').length;
    return `<a class="nav-item ${r.view === 'project' && r.id === p.id ? 'active' : ''}" href="#/p/${p.id}"${r.view === 'project' && r.id === p.id ? ' aria-current="page"' : ''}>
      <span class="dot ${rep ? rep.health : ''}"></span>
      <span class="grow">${esc(p.name)}</span>
      ${live ? `<span class="count live">${live}</span>` : ''}
    </a>`;
  }).join('');
  const dr = S.settings.dailyReport;
  $('#sidebar').innerHTML = `
    <a class="nav-item ${r.view === 'office' ? 'active' : ''}" href="#/office"${r.view === 'office' ? ' aria-current="page"' : ''}><span class="grow">Office</span></a>
    <a class="nav-item ${r.view === 'today' ? 'active' : ''}" href="#/today"${r.view === 'today' ? ' aria-current="page"' : ''}><span class="grow">Today</span></a>
    <a class="nav-item ${r.view === 'costs' ? 'active' : ''}" href="#/costs"${r.view === 'costs' ? ' aria-current="page"' : ''}><span class="grow">Costs</span></a>
    <a class="nav-item ${r.view === 'settings' ? 'active' : ''}" href="#/settings"${r.view === 'settings' ? ' aria-current="page"' : ''}><span class="grow">Settings</span></a>
    <div class="nav-label">Projects</div>
    ${items || '<div class="empty">No projects yet.</div>'}
    <a class="nav-item add" href="#" data-add-project><span class="grow">+ Add project</span></a>
    <div class="nav-foot">
      <button class="btn sm ghost hk-btn" data-people title="Staff and contractors behind each project and role">People</button>
      <button class="btn sm ghost hk-btn" data-housekeeping title="Remove old worktrees and merged branches, archive old tasks">Housekeeping</button>
      <div>Stand-up: ${dr.enabled ? (S.nextDaily ? fmtTime(S.nextDaily) : dr.at) : 'off'}</div>
      <div>${S.claude.found ? esc(S.claude.version) : '<span style="color:var(--red)">Claude Code not found</span>'}</div>
      <div title="${esc(S.settings.workspacePath)}">${esc(S.settings.configFile)} · ${S.settings.maxConcurrent} at a time</div>
    </div>`;
}

function problemsNotice() {
  const out = [];
  if (!S.claude.found) out.push('<b>Claude Code was not found.</b> Install it (<code>npm i -g @anthropic-ai/claude-code</code>), run <code>claude</code> once to log in, then restart Dev Crew.');
  for (const p of S.problems) out.push(`<b>Config:</b> ${esc(p)}`);
  const missing = S.projects.filter(p => !p.exists);
  if (missing.length) out.push(`<b>Folder not found</b> for ${missing.map(p => esc(p.name)).join(', ')}. Clone the repos into <code>${esc(S.settings.workspacePath)}</code> or edit <code>${esc(S.settings.configFile)}</code>.`);
  return out.map(x => `<div class="notice">${x}</div>`).join('');
}

/* ---------------- Office (3D) ---------------- */

function renderOffice() {
  const main = $('#main');
  main.classList.add('full');
  if (!officeEl) {
    officeEl = document.createElement('div');
    officeEl.className = 'office-wrap';
    officeEl.innerHTML = `
      <div class="office-stage" id="officeStage"></div>
      <div class="office-head">
        <button class="icon-btn panel-toggle" data-panel="head" aria-label="Hide or show the legend" title="Hide or show">–</button>
        <h1>The office</h1>
        <p>Click someone to give them work or see what they are doing; click a floor to open that project. Free people from every project meet in the café &amp; lounge: coffee, plants, ping-pong and foosball.</p>
        <ul class="legend">
          <li><i class="lg free">🙂</i>Free</li>
          <li><i class="lg busy">😤</i>Busy</li>
          <li><i class="lg review">🤔</i>Waiting for your review</li>
          <li><i class="lg failed">😵</i>Needs attention</li>
        </ul>
      </div>
      <div class="office-tools">
        <button class="icon-btn" data-office="in" aria-label="Zoom in">+</button>
        <button class="icon-btn" data-office="out" aria-label="Zoom out">−</button>
        <button class="btn sm" data-office="fit">Fit</button>
      </div>
      <section class="office-feed" aria-label="Live activity"><button class="icon-btn panel-toggle" data-panel="feed" aria-label="Hide or show live activity" title="Hide or show">–</button><h2>Live</h2><ol id="officeFeed"></ol></section>`;
    // The legend and the live feed fold away so they do not cover the office; remembered per browser.
    for (const k of ['head', 'feed']) {
      let folded = false;
      try { folded = localStorage.getItem(`devcrew-fold-${k}`) === '1'; } catch { /* private mode */ }
      officeEl.querySelector(k === 'head' ? '.office-head' : '.office-feed').classList.toggle('folded', folded);
    }
    officeEl.addEventListener('click', e => {
      const b = e.target.closest('[data-panel]');
      if (!b) return;
      const panel = b.closest('.office-head, .office-feed');
      const folded = panel.classList.toggle('folded');
      b.textContent = folded ? '+' : '–';
      try { localStorage.setItem(`devcrew-fold-${b.dataset.panel}`, folded ? '1' : '0'); } catch { /* private mode */ }
    });
    for (const b of officeEl.querySelectorAll('[data-panel]')) b.textContent = b.closest('.folded') ? '+' : '–';
  }
  if (!main.contains(officeEl)) main.replaceChildren(officeEl);
  if (!office) {
    office = 'loading';
    import('./office3d.js').then(m => {
      office = m.createOffice($('#officeStage'), {
        quality: (S.settings.ui || {}).quality || 'high',
        onAgent: (pid, role) => openAgentCard(pid, role),
        onZone: pid => { location.hash = `#/p/${pid}`; },
        onHub: () => { location.hash = '#/today'; },
      });
      if (!office) {
        $('#officeStage').innerHTML = '<div class="notice" style="margin:96px 24px 0">This browser could not start 3D graphics (WebGL). The <a href="#/today">Today</a> page shows the same information.</div>';
        office = { update() {}, start() {}, stop() {}, fit() {}, zoomBy() {} };
      }
      if (route().view === 'office') renderOffice();
    }).catch(e => {
      office = null;
      $('#officeStage').innerHTML = `<div class="notice" style="margin:96px 24px 0">Could not load the 3D office: ${esc(e.message)}</div>`;
    });
    return;
  }
  if (office === 'loading') return;
  office.update(S, activity);
  office.start();
  refreshAgentCard();
  const items = feed.slice(0, 7).map(f => {
    const p = projOf(f.projectId);
    return `<li data-task="${f.task}" tabindex="0" role="button">${roleChip(f.role)}<span class="f-text"><b>${esc(p ? p.name : '')}</b> ${esc(f.text)}</span><time>${ago(f.at)}</time></li>`;
  }).join('');
  const running = S.tasks.filter(t => t.status === 'running');
  $('#officeFeed').innerHTML = items || (running.length
    ? running.map(t => `<li data-task="${t.id}" tabindex="0" role="button">${roleChip(t.role)}<span class="f-text"><b>${esc((projOf(t.projectId) || {}).name || '')}</b> ${esc(t.title)}</span></li>`).join('')
    : recentFeed() || '<li class="f-empty">Quiet right now. Assign a task and the work shows up here as it happens.</li>');
}

/* ---------------- monday tickets, the agent card, people ---------------- */

const boardOf = pid => (S.monday && S.monday.boards && S.monday.boards[pid]) || null;
const isDone = s => /^(done|complete|completed|closed|resolved)$/i.test(String(s || '').trim());
function ticketPill(status) {
  const s = String(status || '');
  const cls = isDone(s) ? 'green' : /stuck|block/i.test(s) ? 'red' : /work|progress|review|doing/i.test(s) ? 'amber' : '';
  return `<span class="pill ${cls}">${esc(s || 'No status')}</span>`;
}
const ticketsFor = (pid, role) => {
  const b = boardOf(pid);
  return b ? b.items.filter(i => i.roles.includes(role)).sort((x, y) => isDone(x.status) - isDone(y.status)) : [];
};
const taskForTicket = (pid, itemId) => S.tasks.find(t => t.projectId === pid && t.ticket && t.ticket.itemId === itemId);
const personByName = n => (S.people || []).find(p => p.name === n);

/** What the agent says when you walk up to them. */
function agentSays(pid, role) {
  const mine = tasksOf(pid).filter(t => t.role === role);
  const run = mine.find(t => t.status === 'running');
  const queued = mine.filter(t => t.status === 'queued');
  const last = mine.find(t => t.status !== 'running' && t.status !== 'queued');
  const open = ticketsFor(pid, role).filter(i => !isDone(i.status));
  const stuck = open.find(i => /stuck|block/i.test(i.status));
  if (run) {
    const tk = run.ticket ? `the “${run.ticket.name}” ticket` : `“${run.title}”`;
    return `I'm on ${tk}. Right now: ${activity[run.id] || 'getting started'}.${queued.length ? ` After that I have ${queued.length} more lined up.` : ''}`;
  }
  if (last && last.status === 'failed') return `I got stuck on “${last.title}”: ${String(last.error || '').split('\n')[0].slice(0, 140)} Send me a follow-up and I'll pick it up again.`;
  if (last && needsReview(last)) return `I finished “${last.title}”. It's on branch ${last.branch}, ${last.git.commits.length} commit${last.git.commits.length > 1 ? 's' : ''}, waiting for your review.`;
  if (queued.length) return `I have ${queued.length} task${queued.length > 1 ? 's' : ''} lined up. Next: “${queued[queued.length - 1].title}”.`;
  if (open.length) return `I'm free. ${open.length} ticket${open.length > 1 ? 's are' : ' is'} open for my role on the board${stuck ? `; “${stuck.name}” is stuck and could use me` : ''}. Pick one and I'll start.`;
  return 'I\'m free, and nothing on the board is waiting for my role. Give me something to do.';
}

function agentCardHtml(pid, role) {
  const p = projOf(pid);
  const r = roleOf(role);
  const b = boardOf(pid);
  const items = ticketsFor(pid, role).slice(0, 5);
  const contacts = ((S.contacts || {})[pid] || {})[role] || [];
  const mine = tasksOf(pid).filter(t => t.role === role);
  const current = mine.find(t => t.status === 'running') || mine.find(t => t.status === 'failed' || needsReview(t));
  const rows = items.map(i => {
    const t = taskForTicket(pid, i.id);
    // sample tickets (no monday.com) are not real work in the repo: nothing to assign
    let act = b && b.demo ? '<span class="tk-sample" title="A made-up ticket: monday.com is not connected">Sample</span>' : `<button class="btn sm" data-ticket-work="${esc(i.id)}">Work on it</button>`;
    if (t && (t.status === 'running' || t.status === 'queued')) act = `<button class="btn sm ghost" data-task="${t.id}">${t.status === 'running' ? 'Working' : 'Queued'}</button>`;
    else if (t && t.status === 'done' && t.noChanges) act = `<button class="btn sm ghost warn-btn" data-task="${t.id}" title="The agent finished without changing anything: open it to see why">No changes · see why</button>`;
    else if (t && t.status === 'done' && !t.ticket.postedAt) act = `<button class="btn sm" data-ticket-post="${t.id}" title="Post the agent's report as an update on the ticket">Post report</button>`;
    else if (t) act = `<button class="btn sm ghost" data-task="${t.id}">View task</button>`;
    return `<li><div class="tk-main">${ticketPill(i.status)}<span class="tk-name" title="${esc(i.name)}">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.name)}</a>` : esc(i.name)}</span></div>
      <div class="tk-meta">${i.due ? `Due ${esc(i.due)}` : ''}${i.people.length ? `${i.due ? ' · ' : ''}${esc(i.people.join(', '))}` : ''}</div>${act}</li>`;
  }).join('');
  return `<div class="ac" style="--rc:${r.color}">
    <header><span class="avatar sm">${esc(r.short)}</span><div class="ac-who"><b>${esc(r.name)}</b><span>${esc(p ? p.name : pid)}</span></div><button class="icon-btn" data-card-close aria-label="Close">✕</button></header>
    <p class="say">${esc(agentSays(pid, role))}</p>
    <section><h4>On the board${b && b.demo ? ' <span class="demo-tag" title="Connect monday.com in the config to see your real board">demo</span>' : ''}</h4>
      ${b && b.demo && items.length ? '<p class="demo-note">These are <b>sample tickets</b> to show how the board looks. They are not work in your repo, so they cannot be assigned. Use <b>Assign a task</b> below, or connect monday.com in Settings → Integrations.</p>' : ''}
      ${items.length ? `<ul class="tickets">${rows}</ul>` : '<p class="muted">No tickets for this role.</p>'}
      ${b && b.error ? `<p class="err-line">${esc(b.error)}</p>` : ''}</section>
    ${contacts.length ? `<section><h4>Ask a person</h4><div class="contacts">${contacts.map(n => {
      const pp = personByName(n) || { name: n };
      return `<button class="contact" data-person="${esc(n)}"><b>${esc(n)}</b><span>${esc([pp.title, pp.company].filter(Boolean).join(', '))}${pp.contractor ? ' · contractor' : ''}</span></button>`;
    }).join('')}</div></section>` : ''}
    <footer>
      <button class="btn sm primary" data-act="assign" data-project="${pid}" data-role="${role}">Assign a task</button>
      ${current ? `<button class="btn sm" data-task="${current.id}">Open current task</button>` : ''}
      <a class="btn sm ghost" href="#/p/${pid}/tasks" data-rolefilter="${role}">History</a>
    </footer>
  </div>`;
}

function openAgentCard(pid, role) {
  if (!office || !office.focus) return openAssign({ projectId: pid, role });
  ui.card = { pid, role };
  if (!ui.cardEl) ui.cardEl = document.createElement('div');
  ui.cardEl.innerHTML = agentCardHtml(pid, role);
  office.focus(pid, role);
  office.attachCard(ui.cardEl, pid, role);
}
function closeAgentCard() {
  if (!ui.card) return;
  ui.card = null;
  if (office && office.release) { office.release(); office.detachCard(); }
}
function refreshAgentCard() {
  if (!ui.card || !ui.cardEl) return;
  if (ui.card.kind === 'person') return;
  const html = agentCardHtml(ui.card.pid, ui.card.role);
  if (ui.cardEl.innerHTML !== html) ui.cardEl.innerHTML = html;
}

/* ---------- "Who should I ask?" ---------- */

let searchTimer = 0;
let lastSearch = null;

function contactLinks(p) {
  const links = [];
  if (p.email) links.push(`<a class="btn sm" href="mailto:${encodeURIComponent(p.email)}">Email</a>`);
  if (p.teams || p.email) links.push(`<a class="btn sm" href="https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(p.teams || p.email)}" target="_blank" rel="noopener">Chat in Teams</a>`);
  if (p.email) links.push(`<button class="btn sm ghost" data-copy="${esc(p.email)}">Copy email</button>`);
  return links.join('');
}

function personCardHtml(res, parsed) {
  const p = res.person;
  return `<div class="pc">
    <div class="pc-name">${esc(p.name)}</div>
    <div class="pc-sub">${esc([p.title, p.company].filter(Boolean).join(', '))}${p.contractor ? ' <span class="pill amber">Contractor</span>' : ''}</div>
    <ul class="pc-why">${res.why.map(w => `<li>${esc(w)}</li>`).join('')}${p.hours ? `<li>Available ${esc(p.hours)}</li>` : ''}</ul>
    ${res.tickets && res.tickets.length ? `<div class="pc-tix">${res.tickets.map(t => `<div>${ticketPill(t.status)} ${esc(t.name)}</div>`).join('')}</div>` : ''}
    <div class="pc-actions">${contactLinks(p)}
      <button class="btn sm primary" data-person-assign="${esc(p.name)}" data-project="${esc(parsed.projectId || '')}" data-role="${esc((parsed.roles || [])[0] || '')}">Assign a ticket</button>
    </div>
  </div>`;
}

async function runSearch(q) {
  const pop = $('#peoplePop');
  if (!q.trim()) { pop.hidden = true; return; }
  let r;
  try { r = await api(`/api/people/search?q=${encodeURIComponent(q)}`); } catch (e) { toast(e.message, true); return; }
  lastSearch = r;
  const scope = [r.parsed.roleNames.join(' and '), r.parsed.projectName && `on ${r.parsed.projectName}`].filter(Boolean).join(' ');
  if (!r.results.length) {
    pop.innerHTML = `<div class="pp-empty">Nobody listed${scope ? ` for ${esc(scope)}` : ''}. Add people to the <code>people</code> list in <code>${esc(S.settings.configFile)}</code>, or put them on tickets in the monday board.</div>`;
  } else {
    const [top, ...rest] = r.results;
    const strong = rest.filter(x => x.score >= 8);
    const weak = rest.filter(x => x.score < 8).slice(0, 4);
    pop.innerHTML = `<div class="pp-head">${scope ? `Best person for ${esc(scope)}` : 'Best match'}</div>
      ${personCardHtml(top, r.parsed)}
      ${strong.length ? `<div class="pp-head">Also</div>${strong.map(x => `<button class="pp-row" data-pick="${esc(x.person.name)}"><b>${esc(x.person.name)}</b><span>${esc(x.why.join('; '))}</span></button>`).join('')}` : ''}
      ${weak.length ? `<div class="pp-head">Others${r.parsed.projectName ? ` on ${esc(r.parsed.projectName)}` : ''}</div>${weak.map(x => `<button class="pp-row" data-pick="${esc(x.person.name)}"><b>${esc(x.person.name)}</b><span>${esc([x.person.title, x.person.company].filter(Boolean).join(', '))}</span></button>`).join('')}` : ''}`;
    // in the office, walk the camera over to that desk and pin the name above the agent
    const role = r.parsed.roles[0] || (top.person.roles || [])[0];
    const pid = r.parsed.projectId || (top.person.projects || []).find(x => x !== '*') || (top.tickets[0] || {}).projectId;
    if (route().view === 'office' && office && office.focus && pid && role) {
      ui.card = { kind: 'person', pid, role };
      if (!ui.cardEl) ui.cardEl = document.createElement('div');
      ui.cardEl.innerHTML = `<div class="ac name-tag" style="--rc:${roleOf(role).color}"><header><span class="avatar sm">${esc(roleOf(role).short)}</span><div class="ac-who"><span>Ask about ${esc(roleOf(role).name.toLowerCase())} on ${esc((projOf(pid) || {}).name || pid)}</span><b class="big">${esc(top.person.name)}</b><span>${esc(top.person.company || '')}${top.person.contractor ? ' · contractor' : ''}</span></div><button class="icon-btn" data-card-close aria-label="Close">✕</button></header></div>`;
      office.focus(pid, role, { zoom: 2.2 });
      office.attachCard(ui.cardEl, pid, role);
    }
  }
  pop.hidden = false;
}

function pickPerson(name) {
  if (!lastSearch) return;
  const i = lastSearch.results.findIndex(x => x.person.name === name);
  if (i > 0) lastSearch.results.unshift(...lastSearch.results.splice(i, 1));
  const top = lastSearch.results[0];
  const pop = $('#peoplePop');
  pop.innerHTML = `<div class="pp-head">${esc(top.person.name)}</div>${personCardHtml(top, lastSearch.parsed)}`;
}

function showPerson(name, pid, role) {
  const p = personByName(name);
  if (!p) return;
  lastSearch = { parsed: { projectId: pid, roles: [role] }, results: [{ person: p, why: [`${roleOf(role).name} contact for ${(projOf(pid) || {}).name || pid}`], tickets: [] }] };
  $('#peopleQ').value = '';
  $('#peoplePop').innerHTML = `<div class="pp-head">Ask a person</div>${personCardHtml(lastSearch.results[0], lastSearch.parsed)}`;
  $('#peoplePop').hidden = false;
}

/* ---------- assign a ticket to a person (writes to monday.com) ---------- */

function openPersonAssign(name, projectId, role) {
  const person = personByName(name);
  const dlg = $('#assignDlg');
  const projects = S.projects.filter(p => !person || person.projects.includes('*') || person.projects.includes(p.id) || !person.projects.length);
  const pid = projectId || (projects[0] || S.projects[0]).id;
  dlg.innerHTML = `<form method="dialog" id="personForm">
    <div class="m-head"><h2>Assign a ticket to ${esc(name)}</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <div class="field"><label>Project board</label><select name="projectId">${(projects.length ? projects : S.projects).map(p => `<option value="${p.id}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="mode-pick">
        <label><input type="radio" name="kind" value="existing" checked><b>An existing ticket</b><span>Add ${esc(name.split(' ')[0])} to a ticket on the board.</span></label>
        <label><input type="radio" name="kind" value="new"><b>A new ticket</b><span>Create it on the board, assigned to ${esc(name.split(' ')[0])}.</span></label>
      </div>
      <div class="field" id="pfExisting"><label>Ticket</label><select name="itemId"></select></div>
      <div id="pfNew" hidden>
        <div class="field"><label>Ticket name</label><input type="text" name="name" maxlength="250" placeholder="e.g. Explain the reservation locking in Program.cs"></div>
        <div class="field"><label>Description <span style="font-weight:400;color:var(--faint)">(optional)</span></label><textarea name="description" rows="3"></textarea></div>
        <div class="field"><label>Crew role</label><select name="role"><option value="">None</option>${S.roles.map(r => `<option value="${r.id}" ${r.id === role ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      </div>
      <p class="hint" id="pfNote"></p>
    </div>
    <div class="m-foot"><span></span><div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" id="pfSubmit">Assign</button></div></div>
  </form>`;
  const form = $('#personForm');
  const F = form.elements;
  const fill = () => {
    const b = boardOf(F.projectId.value);
    const items = b ? b.items.filter(i => !isDone(i.status)) : [];
    items.sort((x, y) => (y.roles.includes(role) ? 1 : 0) - (x.roles.includes(role) ? 1 : 0));
    F.itemId.innerHTML = items.map(i => `<option value="${esc(i.id)}">${esc(i.name)} — ${esc(i.status || 'no status')}${i.people.length ? ` (${esc(i.people.join(', '))})` : ''}</option>`).join('') || '<option value="">No open tickets</option>';
    $('#pfNote').textContent = b && b.demo
      ? 'This is a demo board: the change stays in Dev Crew. Connect monday.com in the config to update your real board.'
      : `This updates the ticket on monday.com${b ? ` (${b.boardName})` : ''}.`;
  };
  const kind = () => {
    const isNew = F.kind.value === 'new';
    $('#pfExisting').hidden = isNew;
    $('#pfNew').hidden = !isNew;
    F.name.required = isNew;
  };
  F.projectId.addEventListener('change', fill);
  form.querySelectorAll('input[name=kind]').forEach(i => i.addEventListener('change', kind));
  form.addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const btn = $('#pfSubmit');
    btn.disabled = true;
    try {
      const isNew = F.kind.value === 'new';
      const body = isNew
        ? { projectId: F.projectId.value, person: name, name: F.name.value, description: F.description.value, role: F.role.value }
        : { projectId: F.projectId.value, person: name, itemId: F.itemId.value };
      if (!isNew && !body.itemId) throw new Error('There is no open ticket to pick. Create a new one instead.');
      const r = await api(isNew ? '/api/monday/create' : '/api/monday/assign', { method: 'POST', body });
      toast(`${isNew ? 'Created' : 'Assigned'} “${r.item ? r.item.name : body.name}” for ${name}${r.demo ? ' (demo board)' : ' on monday.com'}`);
      dlg.close();
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  fill();
  kind();
  dlg.showModal();
}

/* ---------------- Today ---------------- */

function todayView() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const review = S.tasks.filter(needsReview);
  const failed = S.tasks.filter(t => t.status === 'failed' && Date.now() - (t.endedAt || t.createdAt) < 3 * 864e5);
  const todays = S.tasks.filter(t => isToday(t.createdAt) || t.status === 'running' || t.status === 'queued');

  const cards = S.projects.map(p => {
    const ts = tasksOf(p.id);
    const rep = latestReport(p.id);
    const runningRep = S.reports.find(r => r.projectId === p.id && (r.status === 'running' || r.status === 'queued'));
    const busy = new Set(ts.filter(t => t.status === 'running').map(t => t.role));
    const headline = rep ? (/##\s*Headline\s*\n+([^\n#][^\n]*)/i.exec(rep.markdown || '') || [])[1] || rep.healthReason : '';
    return `<div class="card proj-card">
      <div class="top"><h3><a href="#/p/${p.id}">${esc(p.name)}</a></h3>${healthPill(rep)}</div>
      ${clampText(p.stack || '', 'stack')}
      <div class="headline ${headline ? '' : 'none'}">${runningRep ? 'Writing today\'s stand-up…' : headline ? inline(headline) + `<div style="color:var(--faint);font-size:11.5px;margin-top:4px">${rep.date} stand-up</div>` : 'No stand-up yet. Run one to get the crew\'s view.'}</div>
      <div class="stats">
        <div><b>${num(ts.filter(t => t.status === 'running').length, p.id + '-run')}</b>working</div>
        <div><b>${num(ts.filter(t => t.status === 'queued').length, p.id + '-queue')}</b>queued</div>
        <div><b>${num(ts.filter(needsReview).length, p.id + '-review')}</b>to review</div>
        <div><b>${num(ts.filter(t => t.status === 'done' && isToday(t.endedAt)).length, p.id + '-done')}</b>done today</div>
      </div>
      <div class="crew-strip">${crewRoles(p).map(r => roleChip(r.id, busy.has(r.id) ? 'busy' : 'idle')).join('')}</div>
      <div class="card-actions">
        <button class="btn sm" data-act="assign" data-project="${p.id}">Assign</button>
        <a class="btn sm ghost" href="#/p/${p.id}/standups">Stand-ups</a>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-head">
      <div><h1>${greet}</h1><div class="sub">${dateStr} · ${S.projects.length} project${S.projects.length === 1 ? '' : 's'}</div></div>
    </div>
    ${problemsNotice()}
    <div class="proj-grid">${cards}</div>
    ${review.length ? `<div class="section-title">Ready for your review (${review.length})</div><div class="card list">${review.map(t => taskRow(t, true)).join('')}</div>` : ''}
    ${failed.length ? `<div class="section-title">Failed (${failed.length})</div><div class="card list">${failed.map(t => taskRow(t, true)).join('')}</div>` : ''}
    <div class="section-title">Today's work</div>
    <div class="card list">${todays.length ? todays.map(t => taskRow(t, true)).join('') : '<div class="empty">Nothing assigned today. Press <b>+ Assign task</b>.</div>'}</div>`;
}

function taskRow(t, showProject) {
  const p = projOf(t.projectId);
  const where = t.mode === 'change' ? (t.branch || `${t.repo} · new branch`) : `${t.repo === '*' ? 'whole project' : t.repo} · read-only`;
  const eta = etaText(t);
  const parent = t.parentId && taskOf(t.parentId);
  const from = parent ? ` · ↳ ${t.origin === 'plan' ? 'plan step' : 'from ' + roleOf(parent.role).short}` : '';
  const waits = t.status === 'queued' && waitingOn(t).length ? ` · waits for ${waitingOn(t).map(d => roleOf(d.role).short).join(', ')}` : '';
  const live = from + waits + (eta && !waits ? ` · ${eta}` : '') + (t.status === 'running' && activity[t.id] ? ` — ${activity[t.id]}` : '');
  return `<div class="row" data-task="${t.id}">
    <div>${roleChip(t.role)}</div>
    <div style="min-width:0">
      <div class="title">${esc(t.title)}</div>
      <div class="meta">${showProject && p ? esc(p.name) + ' · ' : ''}${esc(where)}${esc(live)}</div>
    </div>
    ${statusPill(t)}
    <div class="when">${ago(t.endedAt || t.startedAt || t.createdAt)}</div>
  </div>`;
}

/* ---------------- Quality profile (Edit project) ---------------- */

const Q_CHECKS = [['build', 'Build', 'dotnet build'], ['lint', 'Lint', 'npx eslint .'], ['format', 'Format check', 'dotnet format --verify-no-changes'], ['test', 'Tests', 'dotnet test']];

function qualityFields(p) {
  const q = p.quality || {};
  const c = q.commands || {};
  return `<fieldset class="field quality-box"><legend>Quality profile <span class="faint">(what "done" means here: agents run these commands, the Code Reviewer checks against these rules)</span></legend>
    <div class="grid2">${Q_CHECKS.map(([k, l, ph]) => `<label class="q-cmd">${l}<input type="text" name="q_${k}" maxlength="300" spellcheck="false" value="${esc(c[k] || '')}" placeholder="${esc(ph)}"></label>`).join('')}</div>
    <div class="card-actions" style="margin:4px 0 8px"><button type="button" class="btn sm ghost" data-q-suggest>Suggest from the repos</button><span class="hint" id="qHint">Leave a command blank to skip it. They run in the task's worktree, from the repo root.</span></div>
    <label>Conventions the reviewer checks <span class="faint">(one per line)</span><textarea name="q_rules" rows="3" placeholder="Controllers stay thin: logic goes in services&#10;Errors return ProblemDetails&#10;No raw SQL outside the repositories">${esc((q.rules || []).join('\n'))}</textarea></label>
    <label class="check"><input type="checkbox" name="q_requireTests" ${q.requireTests ? 'checked' : ''}> New public methods, endpoints and components need tests</label>
    <label class="check"><input type="checkbox" name="q_noNewWarnings" ${q.noNewWarnings ? 'checked' : ''}> No new compiler or linter warnings</label>
    <label class="check"><input type="checkbox" name="q_verify" ${q.verify === false ? '' : 'checked'}> Dev Crew runs the checks itself on every branch: results show on the task, and a failing check blocks the reviewer's approval</label>
  </fieldset>`;
}

async function suggestQuality(form, pid) {
  const hint = $('#qHint');
  if (!pid) { hint.textContent = 'Save the project first, then Dev Crew can look at its repos.'; return; }
  hint.textContent = 'Looking at the repos…';
  try {
    const r = await api(`/api/projects/${encodeURIComponent(pid)}/quality/suggest`);
    const filled = [];
    for (const [k, l] of Q_CHECKS) {
      const box = form.elements[`q_${k}`];
      if (!box.value.trim() && r.commands[k]) { box.value = r.commands[k]; filled.push(l); }
    }
    hint.textContent = filled.length ? `Filled in ${filled.join(', ')} for ${r.stack.slice(0, 3).join(', ') || 'this stack'}. Check them, then Save.` : Object.keys(r.commands).length ? 'Nothing to add: the boxes with a suggestion are already filled.' : 'No suggestion for this stack; type the commands you use.';
  } catch (e) { hint.textContent = e.message; }
}

/* ---------------- Project ---------------- */

/* The Graph tab: graphify's interactive map of a repo, how fresh it is, and keeping it current. */
const graphUi = { repo: '', info: null };

function graphTab(p) {
  return `<div id="graphPage" data-pid="${esc(p.id)}">
    <div class="card graph-bar" id="graphBar"><span class="faint">Loading the graph…</span></div>
    <div class="graph-frame" id="graphFrame"></div>
  </div>`;
}

async function loadGraph(pid, { reloadView = false } = {}) {
  let info;
  try { info = await api(`/api/projects/${encodeURIComponent(pid)}/graph`); } catch (e) { $('#graphBar').innerHTML = `<span class="err-inline">${esc(e.message)}</span>`; return; }
  const page = $('#graphPage');
  if (!page || page.dataset.pid !== pid) return;
  graphUi.info = info;
  const withGraph = info.repos.filter(r => r.exists);
  if (!graphUi.repo || !info.repos.some(r => r.repo === graphUi.repo)) graphUi.repo = (withGraph[0] || info.repos[0] || {}).repo || '';
  const r = info.repos.find(x => x.repo === graphUi.repo);
  const bar = $('#graphBar');
  if (!r) { bar.innerHTML = '<span class="faint">This project has no git repos.</span>'; $('#graphFrame').innerHTML = ''; return; }
  const job = r.job;
  const busy = job && (job.running || job.queued);
  const fmt = n => (n || 0).toLocaleString();
  const when = r.builtAt ? `${fmtTime(r.builtAt)} (${ago(r.builtAt)})` : '';
  const pick = info.repos.length > 1
    ? `<select id="graphRepo" aria-label="Repo">${info.repos.map(x => `<option value="${esc(x.repo)}" ${x.repo === r.repo ? 'selected' : ''}>${esc(x.repo)}${x.exists ? '' : ' (no graph)'}</option>`).join('')}</select>`
    : `<b>${esc(r.repo)}</b>`;
  const status = !r.exists
    ? 'No graph yet. Build the first one with <code>/graphify</code> in Claude Code for this repo; after that Dev Crew keeps it current.'
    : `${fmt(r.nodes)} nodes · ${fmt(r.edges)} links · ${fmt(r.communities)} areas · built ${esc(when)}${r.commitsSince ? ` · <b class="warn">${r.commitsSince} commit${r.commitsSince === 1 ? '' : 's'} on ${esc(r.branch || 'the branch')} since</b>` : ' · <span class="ok-text">up to date with the latest commit</span>'}`;
  const jobLine = busy ? `<span class="graph-job">${job.queued ? 'Waiting to update…' : 'Updating the graph…'}</span>`
    : job && job.ok === false ? `<span class="err-inline" title="${esc(job.output || '')}">Update failed: ${esc(job.error || '')}</span>`
      : job && job.ok && job.unchanged ? `<span class="ok-text">Checked ${ago(job.endedAt)}: no code changes since the last build</span>`
      : job && job.ok ? `<span class="ok-text">Updated ${ago(job.endedAt)}${job.why && job.why !== 'manual' ? ` (${esc(job.why)})` : ''}</span>` : '';
  bar.innerHTML = `<div class="graph-top">${pick}<span class="grow"></span>
      ${r.exists ? `<label class="graph-auto">Keep it current <select id="graphMode">${[['off', 'Only when I press Update'], ['commits', 'After new commits'], ['weekly', 'Once a week']].map(([v, l]) => `<option value="${v}" ${info.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
      ${r.hasView ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="/api/projects/${encodeURIComponent(pid)}/graph/${encodeURIComponent(r.repo)}/view">Open full screen</a>` : ''}
      ${r.exists ? `<button class="btn sm primary" id="graphUpdate" ${busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Update graph'}</button>` : ''}
    </div>
    <div class="graph-status">${status} ${jobLine}</div>
    <p class="hint">Updating reads the code again (no AI, no cost). Click a node to see what it connects to; search finds a class or file. The crew can use this graph when the project's Knowledge graph setting is on (Edit project).</p>`;
  const frame = $('#graphFrame');
  const src = r.hasView ? `/api/projects/${encodeURIComponent(pid)}/graph/${encodeURIComponent(r.repo)}/view` : '';
  const cur = frame.querySelector('iframe');
  if (!src) frame.innerHTML = r.exists ? '<div class="empty">This graph has no viewer page (graph.html). Update it to create one.</div>' : '';
  else if (!cur || cur.dataset.src !== src) frame.innerHTML = `<iframe title="Knowledge graph of ${esc(r.repo)}" data-src="${src}" src="${src}" loading="lazy"></iframe>`;
  else if (reloadView) cur.src = `${src}?t=${Date.now()}`;
}



/* The Lessons tab: what earlier runs learned about each repo, given to every later run there. */
function lessonsTab(p) {
  const repos = p.repos.map(r => r.name);
  return `<div id="lessonsPage" data-pid="${esc(p.id)}">
    <div class="card">
      <p class="hint">Dev Crew keeps short lessons about each repo: what agents report they learned (how it builds, quirks, conventions), commands that were refused, checks that failed, and problems reviewers flagged. The top ones go into every later run in that repo. Pin the ones that matter, mute or delete wrong ones, or add your own (yours are pinned).</p>
      <form id="lessonAdd" class="lesson-add">
        ${repos.length > 1 ? `<select name="repo" aria-label="Repo">${repos.map(r => `<option>${esc(r)}</option>`).join('')}</select>` : `<input type="hidden" name="repo" value="${esc(repos[0] || '*')}">`}
        <input type="text" name="text" maxlength="240" required minlength="12" placeholder="e.g. Run dotnet test from the solution folder; the Api project has no tests of its own">
        <button class="btn sm primary">Add lesson</button>
      </form>
    </div>
    <div id="lessonsList"><div class="empty">Loading…</div></div>
  </div>`;
}

const LESSON_SOURCE = { agent: 'an agent', owner: 'you', refused: 'a refused command', checks: 'failed checks', review: 'a review' };
function renderLessons(view) {
  const el = $('#lessonsList');
  if (!el) return;
  const any = view.repos.some(r => r.lessons.length);
  el.innerHTML = !any ? '<div class="empty">No lessons yet. They appear as the crew works; you can add your own above.</div>'
    : view.repos.filter(r => r.lessons.length).map(r => `<div class="card"><h3>${esc(r.repo === '*' ? 'Whole project' : r.repo)} <span class="faint">· ${r.lessons.length}</span></h3>
      <ul class="lessons">${r.lessons.map((l, i) => `<li class="${l.muted ? 'muted' : ''} ${i < 12 && !l.muted ? 'in-prompt' : ''}">
        <div class="lesson-text">${l.pinned ? '<span title="Pinned" aria-label="Pinned">📌</span> ' : ''}${esc(l.text)}</div>
        <div class="lesson-meta faint">From ${esc(LESSON_SOURCE[l.source] || l.source)} · ${(l.hits || 1) > 1 ? `seen ${l.hits} times · ` : ''}${ago(l.at)}${l.muted ? ' · muted: not given to agents' : i < 12 ? ' · given to agents' : ''}</div>
        <div class="lesson-act">
          <button class="btn sm ghost" data-lesson="${l.id}" data-do="pin">${l.pinned ? 'Unpin' : 'Pin'}</button>
          <button class="btn sm ghost" data-lesson="${l.id}" data-do="mute">${l.muted ? 'Unmute' : 'Mute'}</button>
          <button class="btn sm ghost danger" data-lesson="${l.id}" data-do="del">Delete</button>
        </div></li>`).join('')}</ul></div>`).join('');
}

async function loadLessons(pid) {
  try { renderLessons(await api(`/api/projects/${encodeURIComponent(pid)}/lessons`)); }
  catch (e) { const el = $('#lessonsList'); if (el) el.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
}

document.addEventListener('submit', async e => {
  if (e.target.id !== 'lessonAdd') return;
  e.preventDefault();
  const pid = $('#lessonsPage').dataset.pid;
  const F = e.target.elements;
  try {
    renderLessons(await api(`/api/projects/${encodeURIComponent(pid)}/lessons`, { method: 'POST', body: { repo: F.repo.value, text: F.text.value } }));
    F.text.value = '';
    toast('Lesson added and pinned');
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-lesson]');
  if (!b || !$('#lessonsPage')) return;
  const pid = $('#lessonsPage').dataset.pid;
  const url = `/api/projects/${encodeURIComponent(pid)}/lessons/${encodeURIComponent(b.dataset.lesson)}`;
  const li = b.closest('li');
  try {
    if (b.dataset.do === 'del') { if (!confirm('Delete this lesson? Agents stop getting it.')) return; renderLessons(await api(url, { method: 'DELETE' })); }
    else if (b.dataset.do === 'pin') renderLessons(await api(url, { method: 'PATCH', body: { pinned: !li.querySelector('[aria-label=Pinned]') } }));
    else if (b.dataset.do === 'mute') renderLessons(await api(url, { method: 'PATCH', body: { muted: !li.classList.contains('muted') } }));
  } catch (err) { toast(err.message, true); }
});

function projectView(p, tab) {
  const tabs = [['crew', 'Crew'], ['tasks', 'Tasks'], ['standups', 'Stand-ups'], ['graph', 'Graph'], ['lessons', `Lessons${p.lessonCount ? ` (${p.lessonCount})` : ''}`]];
  const body = tab === 'tasks' ? tasksTab(p) : tab === 'standups' ? standupsTab(p) : tab === 'graph' ? graphTab(p) : tab === 'lessons' ? lessonsTab(p) : crewTab(p);
  return `
    <div class="page-head">
      <div>
        <h1>${esc(p.name)}</h1>
        ${clampText(`${p.stack || ''}${p.context ? ` — ${p.context}` : ''}`, 'sub')}
        <div class="repo-chips">${p.exists
          ? (p.repos.map(r => `<span class="repo-chip" title="${esc(r.path)}">${esc(r.name)}</span>`).join('') || '<span class="repo-chip missing">no git repos in folder</span>')
          : `<span class="repo-chip missing" title="${esc(p.path)}">folder not found</span>`}</div>
      </div>
      <div class="card-actions">
        <button class="btn ghost" data-edit-project="${p.id}">Edit project</button>
        <button class="btn" data-act="standup" data-project="${p.id}">Run stand-up</button>
        <button class="btn primary" data-act="assign" data-project="${p.id}">+ Assign</button>
      </div>
    </div>
    ${p.exists ? '' : problemsNotice()}
    <nav class="tabs" aria-label="Project sections">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? 'active' : ''}" href="#/p/${p.id}/${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    ${body}`;
}

function crewTab(p) {
  const ts = tasksOf(p.id);
  const off = S.roles.filter(r => !crewRoles(p).includes(r));
  return `<div class="crew-grid">${crewRoles(p).map(r => {
    const mine = ts.filter(t => t.role === r.id);
    const run = mine.find(t => t.status === 'running');
    const queued = mine.filter(t => t.status === 'queued').length;
    const last = mine.find(t => t.status !== 'running' && t.status !== 'queued');
    const repo = (p.roles[r.id] || {}).repo;
    const status = run
      ? `<div class="status working"><b>Working:</b> <a href="#" data-task="${run.id}">${esc(run.title)}</a><div class="act">${esc(activity[run.id] || 'starting…')}</div></div>`
      : `<div class="status">${queued ? `${queued} task(s) queued` : 'Idle'}</div>`;
    return `<div class="card agent" style="--rc:${r.color}">
      <div class="who"><div class="avatar">${esc(r.short)}</div><div><h3>${esc(r.name)}</h3><div class="focus">${esc(r.focus)}</div></div></div>
      ${status}
      ${(((S.contacts || {})[p.id] || {})[r.id] || []).length ? `<div class="last">Ask: ${((S.contacts[p.id] || {})[r.id]).map(n => `<a href="#" data-person="${esc(n)}" data-project="${p.id}" data-role="${r.id}">${esc(n)}</a>`).join(', ')}</div>` : ''}
      <div class="last">${last ? `Last: <a href="#" data-task="${last.id}">${esc(last.title)}</a> · ${statusPill(last)} · ${ago(last.endedAt)}` : 'No tasks yet.'}${repo ? `<br>Usually works in <code>${esc(repo)}</code>` : ''}</div>
      <div class="card-actions">
        <button class="btn sm" data-act="assign" data-project="${p.id}" data-role="${r.id}">Assign</button>
        <a class="btn sm ghost" href="#/p/${p.id}/tasks" data-rolefilter="${r.id}">History (${mine.length})</a>
      </div>
    </div>`;
  }).join('')}</div>
  ${off.length ? `<p class="hint" style="margin-top:12px">Not on this project: ${off.map(r => esc(r.name)).join(', ')}. <a href="#" data-edit-project="${p.id}">Change roles</a></p>` : ''}`;
}

function tasksTab(p) {
  const f = ui.taskFilter;
  const filters = [['all', 'All'], ['active', 'Active'], ['review', 'To review'], ['done', 'Done'], ['failed', 'Failed']];
  let ts = tasksOf(p.id);
  if (ui.roleFilter) ts = ts.filter(t => t.role === ui.roleFilter);
  ts = ts.filter(t => f === 'all' || (f === 'active' && (t.status === 'running' || t.status === 'queued')) || (f === 'review' && needsReview(t))
    || (f === 'done' && t.status === 'done') || (f === 'failed' && (t.status === 'failed' || t.status === 'cancelled')));
  return `<div class="filters">
      ${filters.map(([k, l]) => `<button class="chip-btn ${f === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}
      <span style="width:12px"></span>
      <button class="chip-btn ${!ui.roleFilter ? 'on' : ''}" data-role-filter="">All roles</button>
      ${crewRoles(p).map(r => `<button class="chip-btn ${ui.roleFilter === r.id ? 'on' : ''}" data-role-filter="${r.id}">${esc(r.short)}</button>`).join('')}
    </div>
    <div class="card list">${ts.length ? ts.map(t => taskRow(t, false)).join('') : '<div class="empty">No tasks match.</div>'}</div>`;
}

function standupsTab(p) {
  const reps = S.reports.filter(r => r.projectId === p.id);
  if (!reps.length) return `<div class="card empty">No stand-ups yet. They run ${S.settings.dailyReport.enabled ? `every ${S.settings.dailyReport.weekdaysOnly ? 'weekday' : 'day'} at ${esc(S.settings.dailyReport.at)}` : 'when you press Run stand-up'}.</div>`;
  return reps.slice(0, 30).map((r, i) => {
    const head = `<div class="report-head">
      <h3>${esc(r.date)}</h3>
      ${r.status === 'done' ? healthPill(r) : r.status === 'failed' ? '<span class="pill red">Failed</span>' : r.status === 'cancelled' ? '<span class="pill">Cancelled</span>' : '<span class="pill blue">Writing…</span>'}
      <span class="grow" style="color:var(--muted);font-size:12.5px">${esc(r.healthReason || '')}</span>
      <span style="color:var(--faint);font-size:12px">${r.trigger === 'scheduled' ? 'scheduled' : 'on demand'} · ${ago(r.endedAt || r.createdAt)}${r.costUsd ? ' · ' + money(r.costUsd) : ''}</span>
      ${r.status === 'running' || r.status === 'queued' ? `<button class="btn sm" data-report="${r.id}">Progress</button>` : ''}
    </div>`;
    if (r.status !== 'done') return `<div class="card report">${head}${r.error ? `<div class="err-box">${esc(r.error)}</div>` : ''}</div>`;
    const sugg = (r.suggestions || []).map((s, j) => `<div class="suggest-item">
        ${roleChip(s.role)}
        <div class="grow"><div>${esc(s.title)}</div><div class="d">${s.mode === 'analyze' ? 'Investigate' : 'Change'} · ${esc(s.repo === '*' ? 'whole project' : s.repo)}${s.details ? ' — ' + esc(s.details) : ''}</div></div>
        <button class="btn sm" data-suggest="${r.id}:${j}">Assign…</button>
      </div>`).join('');
    const content = `${md(r.markdown)}${sugg ? `<div class="suggest"><div class="report-head"><b class="grow">Suggested tasks for tomorrow</b><button class="btn sm primary" data-suggest-all="${r.id}">Assign all</button></div>${sugg}</div>` : ''}`;
    return `<div class="card report">${head}${i === 0 ? content : `<details><summary>Show stand-up</summary>${content}</details>`}</div>`;
  }).join('');
}

/* ---------------- drawer ---------------- */

let drawerOpener = null;
function openDrawer(kind, id) {
  if (!drawer) drawerOpener = document.activeElement;
  drawer = { kind, id };
  const el = $('#drawer');
  el.innerHTML = `<div class="d-head" id="dHead"></div>
    <div class="d-body"><div id="dInfo"></div>
      <div class="d-section"><h4>Activity <button class="btn sm ghost" id="logBottom">Latest ↓</button></h4><div class="log" id="dLog"></div></div>
    </div>
    <div class="d-foot" id="dFoot"></div>`;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('show');
  refreshDrawer(true);
  const close = el.querySelector('[data-close]');
  if (close) close.focus({ preventScroll: true });
  api(`/api/log/${id}`).then(lines => { $('#dLog').innerHTML = ''; appendLog(lines, true); }).catch(() => {});
}

function closeDrawer() {
  drawer = null;
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('show');
  if (drawerOpener && drawerOpener.isConnected && drawerOpener.focus) drawerOpener.focus({ preventScroll: true });
  drawerOpener = null;
}

function appendLog(lines, force) {
  const box = $('#dLog');
  if (!box) return;
  const atBottom = force || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.insertAdjacentHTML('beforeend', lines.map(l => `<div class="l ${l.kind}">${esc(l.text)}</div>`).join(''));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- costs page ---------------- */

const costFilters = { range: '30', project: '', role: '', model: '' };
const FAILED_STATUS = new Set(['failed', 'cancelled', 'stopped', 'blocked']);

const usd = n => (n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`);
const compact = n => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const pct = n => `${Math.round(n * 100)}%`;

function costRange() {
  const today = new Date();
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (costFilters.range === 'all') return { from: '', to: key(today) };
  if (costFilters.range === 'month') return { from: key(new Date(today.getFullYear(), today.getMonth(), 1)), to: key(today) };
  const from = new Date(today);
  from.setDate(from.getDate() - (Number(costFilters.range) - 1));
  return { from: key(from), to: key(today) };
}

/** Round axis maximum and step: 0 / 0.5 / 1 … with 3–5 ticks. */
function niceScale(max) {
  if (!(max > 0)) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

/** Spend per day: one series of columns, 4px rounded tops, hairline grid, optional limit line. */
function dailyChart(daily, limit) {
  const W = 760, H = 220, L = 50, R = 12, T = 16, B = 26;
  const maxCost = Math.max(...daily.map(d => d.cost), 0);
  // the daily limit is drawn only when it is near the data, so it never flattens the columns
  const showLimit = limit > 0 && limit <= Math.max(maxCost * 3, 0.01);
  const { top, step } = niceScale(Math.max(maxCost, showLimit ? limit : 0));
  const y = v => T + (H - T - B) * (1 - v / top);
  const band = (W - L - R) / daily.length;
  const bw = Math.max(2, Math.min(24, band * 0.62));
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const labelEvery = Math.ceil(daily.length / 8);
  const fmtTick = v => (top < 1 ? `$${v.toFixed(2)}` : top < 10 ? `$${Number.isInteger(v) ? v : v.toFixed(1)}` : `$${Math.round(v)}`);
  const col = (d, i) => {
    const x = L + band * i + (band - bw) / 2;
    const h = Math.max(0, y(0) - y(d.cost));
    const r = Math.min(4, h, bw / 2);
    const tip = `${d.day}: ${usd(d.cost)} · ${d.runs} run${d.runs === 1 ? '' : 's'}`;
    // rounded data-end, square at the baseline
    const path = h > 0.5
      ? `M${x},${y(0)} V${y(d.cost) + r} Q${x},${y(d.cost)} ${x + r},${y(d.cost)} H${x + bw - r} Q${x + bw},${y(d.cost)} ${x + bw},${y(d.cost) + r} V${y(0)} Z`
      : '';
    return `<g class="viz-hit" data-tip="${esc(tip)}"><rect x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>${path ? `<path d="${path}" class="viz-col"/>` : ''}</g>`;
  };
  return `<svg class="viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend per day, ${daily[0].day} to ${daily[daily.length - 1].day}">
    ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'viz-base' : 'viz-grid'}"/><text x="${L - 6}" y="${y(v) + 4}" class="viz-tick" text-anchor="end">${fmtTick(v)}</text>`).join('')}
    ${daily.map(col).join('')}
    ${daily.map((d, i) => {
      // every Nth day; the last day too, unless it would sit on top of the label before it
      const last = i === daily.length - 1;
      const show = i % labelEvery === 0 || (last && i % labelEvery >= labelEvery / 2);
      return show ? `<text x="${L + band * i + band / 2}" y="${H - 8}" class="viz-tick" text-anchor="middle">${d.day.slice(5).replace('-', '/')}</text>` : '';
    }).join('')}
    ${showLimit ? `<line x1="${L}" x2="${W - R}" y1="${y(limit)}" y2="${y(limit)}" class="viz-ref"/><text x="${W - R}" y="${y(limit) - 5}" class="viz-tick" text-anchor="end">Daily limit ${usd(limit)}</text>` : ''}
  </svg>`;
}

/** Ranked horizontal bars, one series: label, bar, value at the tip. */
function rankBars(items, label = x => x.name) {
  if (!items.length) return '<div class="empty">No runs in this range.</div>';
  const max = Math.max(...items.map(i => i.cost)) || 1;
  return `<div class="viz-rank">${items.slice(0, 8).map(i => `
    <div class="viz-rank-row viz-hit" data-tip="${esc(`${label(i)}: ${usd(i.cost)} · ${i.runs} run${i.runs === 1 ? '' : 's'}`)}">
      <span class="viz-rank-label">${esc(label(i))}</span>
      <span class="viz-rank-track"><span class="viz-rank-bar" style="width:${Math.max(0.5, (i.cost / max) * 100)}%"></span></span>
      <span class="viz-rank-value">${usd(i.cost)}</span>
    </div>`).join('')}</div>`;
}

/** The token mix as one tall segmented bar, shares printed inside when they fit. */
function tokenBar(t) {
  const parts = [['Input', t.input, 1], ['Output', t.output, 2], ['Cache read', t.cacheRead, 3], ['Cache write', t.cacheWrite, 4]];
  const total = parts.reduce((a, p) => a + p[1], 0);
  if (!total) return '<div class="empty">No token data in this range.</div>';
  return `<div class="viz-seg" role="img" aria-label="${esc(parts.map(([n, v]) => `${n} ${compact(v)} (${pct(v / total)})`).join(', '))}">
      ${parts.filter(p => p[1] > 0).map(([n, v, slot]) => `<span class="viz-seg-part s${slot} viz-hit" style="flex-grow:${v}" data-tip="${esc(`${n}: ${compact(v)} tokens (${pct(v / total)})`)}">${v / total >= 0.09 ? pct(v / total) : ''}</span>`).join('')}
    </div>
    <ul class="viz-legend">${parts.map(([n, v, slot]) => `<li><i class="sw s${slot}"></i>${n} <b>${compact(v)}</b></li>`).join('')}</ul>`;
}

async function renderCosts(main) {
  main.innerHTML = '<div id="costsPage" class="viz-root"><div class="empty">Loading costs…</div></div>';
  const page = $('#costsPage');
  const { from, to } = costRange();
  const q = new URLSearchParams({ from, to, project: costFilters.project, role: costFilters.role, model: costFilters.model });
  let d;
  try { d = await api(`/api/analytics?${q}`); } catch (e) { page.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; return; }
  if (!$('#costsPage')) return; // navigated away meanwhile
  const o = d.options;
  const sel = (name, cur, opts, all) => `<select data-cost-filter="${name}" aria-label="${esc(all || name)}">${all ? `<option value="">${esc(all)}</option>` : ''}${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const roleName = id => (S.roles.find(r => r.id === id) || {}).name || ({ 'stand-up': 'Stand-ups', 'graph-trial': 'Knowledge-graph trials' })[id] || id;
  const est = d.estimates;
  const empty = !d.totals.runs;

  page.innerHTML = `
    <div class="page-head"><div><h1>Costs</h1><div class="sub">What the crew spent, as Claude Code reports it (API-equivalent cost).${o.hasArchive ? ' Includes archived tasks.' : ''}</div></div></div>
    <div class="viz-filters">
      ${sel('range', costFilters.range, [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['month', 'This month'], ['all', 'All time']], '')}
      ${sel('project', costFilters.project, o.projects.map(p => [p.id, p.name]), 'All projects')}
      ${sel('role', costFilters.role, o.roles.map(r => [r, roleName(r)]), 'All roles')}
      ${sel('model', costFilters.model, o.models.map(m => [m, m]), 'All models')}
      <span class="grow"></span>
      <a class="btn sm" href="/api/analytics.csv?${q}" download>Export CSV</a>
    </div>
    ${empty ? `<div class="card empty-state"><b>No runs in this range yet.</b><p class="hint">Every task and stand-up records its cost, tokens and time. Assign a task and it shows up here.</p></div>` : `
    <div class="viz-tiles">
      <div class="card viz-hero"><span class="viz-label">Spend</span><span class="viz-hero-value">${num(d.totals.cost, 'cost-spend', 'usd')}</span><span class="hint">${d.range.from} to ${d.range.to}</span></div>
      <div class="card viz-tile"><span class="viz-label">Runs</span><span class="viz-value">${num(d.totals.runs, 'cost-runs')}</span><span class="hint">${d.totals.jobs} task(s) and stand-ups</span></div>
      <div class="card viz-tile"><span class="viz-label">Cost per finished task</span><span class="viz-value">${d.finished.count ? num(d.finished.costPerTask, 'cost-per-task', 'usd') : '—'}</span><span class="hint">${d.finished.count} finished</span></div>
      <div class="card viz-tile"><span class="viz-label">Cache hit rate</span><span class="viz-value">${num(d.totals.cacheHitRate, 'cost-cache', 'pct')}</span><span class="hint">of prompt tokens read from cache</span></div>
      <div class="card viz-tile"><span class="viz-label">Spent on failed or stopped work</span><span class="viz-value">${num(d.wasted.cost, 'cost-wasted', 'usd')}</span><span class="hint">${pct(d.wasted.share)} of spend</span></div>
      <div class="card viz-tile"><span class="viz-label">Estimates in range</span><span class="viz-value">${est.count ? pct(est.withinRange) : '—'}</span><span class="hint">${est.count ? `${est.count} task(s); actual ${est.medianRatio.toFixed(2)}× the estimate (median)` : 'no estimated tasks yet'}</span></div>
    </div>

    <section class="card viz-card">
      <h2>Spend per day</h2>
      ${dailyChart(d.daily, d.dailyLimit)}
      <details class="viz-table"><summary>Show as a table</summary>
        <table><thead><tr><th>Day</th><th>Spend</th><th>Runs</th></tr></thead><tbody>
        ${d.daily.filter(x => x.runs).map(x => `<tr><td>${x.day}</td><td>${usd(x.cost)}</td><td>${x.runs}</td></tr>`).join('') || '<tr><td colspan="3">No runs</td></tr>'}
        </tbody></table></details>
    </section>

    <div class="viz-grid3">
      <section class="card viz-card"><h2>By project</h2>${rankBars(d.byProject)}</section>
      <section class="card viz-card"><h2>By role</h2>${rankBars(d.byRole, i => roleName(i.name))}</section>
      <section class="card viz-card"><h2>By model</h2>${rankBars(d.byModel)}</section>
    </div>

    <section class="card viz-card"><h2>Tokens <span class="faint">${compact(d.totals.tokens)} in total</span></h2>${tokenBar(d.tokens)}
      <p class="hint">Cache reads cost a fraction of fresh input; a bigger share of them means cheaper runs.</p></section>

    <div class="viz-grid2">
      <section class="card viz-card"><h2>Most expensive</h2>
        <table class="viz-tbl"><thead><tr><th>Task</th><th>Role</th><th class="num">Runs</th><th class="num">Cost</th></tr></thead><tbody>
        ${d.top.map(j => `<tr ${j.jobKind === 'task' && S.tasks.some(t => t.id === j.jobId) ? `data-task="${j.jobId}" class="clickable"` : ''}><td>${esc(j.title)}${FAILED_STATUS.has(j.status) ? ` <span class="pill red">${esc(j.status)}</span>` : ''}</td><td>${esc(roleName(j.role))}</td><td class="num">${j.runs}</td><td class="num">${usd(j.cost)}</td></tr>`).join('')}
        </tbody></table></section>
      <section class="card viz-card"><h2>Estimate vs actual</h2>
        ${est.count ? `<table class="viz-tbl"><thead><tr><th>Task</th><th class="num">Estimate</th><th class="num">Actual</th><th></th></tr></thead><tbody>
        ${est.rows.map(e => { const inR = e.actual >= e.low && e.actual <= e.high; return `<tr><td>${esc(e.title)}</td><td class="num">${usd(e.low)}–${usd(e.high)}</td><td class="num">${usd(e.actual)}</td><td>${inR ? '<span class="pill green">✓ in range</span>' : e.actual > e.high ? '<span class="pill amber">▲ over</span>' : '<span class="pill">▼ under</span>'}</td></tr>`; }).join('')}
        </tbody></table><p class="hint">Each task's first run against the range shown when it was assigned. Estimates learn from these runs.</p>` : '<div class="empty">No estimated tasks in this range yet.</div>'}
      </section>
    </div>`}
    <div id="vizTip" class="viz-tip" role="tooltip" hidden></div>`;
  animateNumbers(page);

  page.querySelectorAll('[data-cost-filter]').forEach(s => s.addEventListener('change', () => {
    costFilters[s.dataset.costFilter] = s.value;
    renderCosts($('#main'));
  }));
  // one tooltip for every mark, following the pointer
  const tip = $('#vizTip');
  page.addEventListener('pointermove', e => {
    const h = e.target.closest('.viz-hit');
    if (!h) { tip.hidden = true; return; }
    tip.textContent = h.dataset.tip;
    tip.hidden = false;
    const r = page.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
  });
  page.addEventListener('pointerleave', () => { tip.hidden = true; });
}

/* ---------------- simple 2D office ---------------- */

function office2dView() {
  return `<div class="page-head"><div><h1>The office</h1><div class="sub">Simple view. Switch to the 3D office in <a href="#/settings">Settings</a>.</div></div></div>
    ${S.projects.map(p => `<div class="section-title"><a href="#/p/${p.id}">${esc(p.name)}</a></div>${crewTab(p)}`).join('') || '<div class="empty">No projects yet.</div>'}`;
}

/* ---------------- settings page ---------------- */

const SETTINGS_TABS = [['general', 'General'], ['roles', 'Crew & roles'], ['permissions', 'Permissions'], ['integrations', 'Integrations'], ['appearance', 'Appearance'], ['advanced', 'Advanced']];
// Ready-made command sets per stack, on top of what agents may always run.
const PERMISSION_PRESETS = {
  '.NET': ['dotnet tool restore', 'dotnet tool run', 'dotnet ef', 'dotnet pack'],
  Node: ['npm audit', 'npx playwright', 'npx cypress run', 'npx biome', 'node'],
  Python: ['poetry', 'uv run', 'tox', 'python -m ruff', 'python -m black'],
  Java: ['java -version', 'javac'],
  Go: ['golangci-lint', 'go mod'],
  Docker: ['docker build', 'docker compose config'],
};
let settingsTab = 'general';

async function renderSettings(main) {
  main.innerHTML = '<div id="settingsPage"><div class="empty">Loading settings…</div></div>';
  let d;
  let rolesData;
  try { [d, rolesData] = await Promise.all([api('/api/settings'), api('/api/roles')]); } catch (e) {
    $('#settingsPage').innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  if (!$('#settingsPage')) return; // navigated away meanwhile
  const e = d.effective;
  const l = e.limits;
  const dr = e.dailyReport;
  const hk = e.housekeeping;
  const ui = e.ui;
  const mon = (d.settings.monday || {});
  const opt = (v, cur, label = v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const models = cur => [['sonnet', 'Sonnet: balanced'], ['opus', 'Opus: hardest tasks, costs most'], ['haiku', 'Haiku: quick and cheap']]
    .concat(['sonnet', 'opus', 'haiku'].includes(cur) ? [] : [[cur, cur]]).map(([v, t]) => opt(v, cur, t)).join('');
  const seg = (name, cur, choices) => `<div class="seg">${choices.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}" ${v === cur ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>`;
  const chips = list => list.map(c => `<code class="perm">${esc(c)}</code>`).join(' ');
  const sec = (tab, title, body, extra = '') => `<section class="card set-sec" data-tab="${tab}"${extra}><h2>${title}</h2>${body}</section>`;

  $('#settingsPage').innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Saved to <code>${esc(e.configFile)}</code>; the previous version is kept and can be restored (Advanced). Changes apply straight away.</div></div></div>
    <div class="set-nav">
      <nav class="tabs" aria-label="Settings sections">${SETTINGS_TABS.map(([k, t]) => `<button type="button" class="tab ${settingsTab === k ? 'active' : ''}" data-set-tab="${k}" ${settingsTab === k ? 'aria-current="page"' : ''}>${t}</button>`).join('')}</nav>
      <input type="search" id="settingsSearch" placeholder="Find a setting…" aria-label="Find a setting">
    </div>
    <form id="settingsForm" class="settings" data-active="${settingsTab}">
      ${sec('general', 'Agents', `<div class="grid3">
          <div class="field"><label>Default model</label><select name="model">${models(e.model)}</select></div>
          <div class="field"><label>Stand-up model</label><select name="reportModel">${models(e.reportModel)}</select></div>
          <div class="field"><label>Agents at a time</label><input type="number" name="maxConcurrent" min="1" max="8" step="1" value="${e.maxConcurrent}"><span class="hint">More run in parallel, and spend faster.</span></div>
        </div>`)}
      ${sec('general', 'Limits', `<p class="hint">Defaults for every run. Projects and roles can override them in Edit project, and single tasks in the Assign dialog. 0 means no limit.</p>
        <div class="grid4">
          <div class="field"><label>Cost per run (USD)</label><input type="number" name="taskBudgetUsd" min="0" step="0.5" value="${l.taskBudgetUsd}"></div>
          <div class="field"><label>Time per run (minutes)</label><input type="number" name="taskTimeoutMin" min="0" step="5" value="${l.taskTimeoutMin}"></div>
          <div class="field"><label>Daily spend (USD)</label><input type="number" name="dailyBudgetUsd" min="0" step="1" value="${l.dailyBudgetUsd}"></div>
          <div class="field"><label>Warn at (%)</label><input type="number" name="warnAtPercent" min="50" max="95" step="5" value="${Math.round(l.warnAt * 100)}"></div>
        </div>`)}
      ${sec('general', 'Alerts', alertSettingsHtml())}
      ${sec('general', 'Handoffs', `<p class="hint">When a finished task says another role should act next. Projects can override this.</p>
        ${seg('handoffs', e.handoffs, [['ask', 'Ask me first'], ['auto', 'Start automatically'], ['off', 'Off']])}`)}
      ${sec('general', 'Daily stand-up', `<div class="grid3">
          <label class="check"><input type="checkbox" name="drEnabled" ${dr.enabled ? 'checked' : ''}> Write a stand-up for every project each morning</label>
          <div class="field"><label>Time</label><input type="time" name="drAt" value="${esc(dr.at)}"></div>
          <label class="check"><input type="checkbox" name="drWeekdays" ${dr.weekdaysOnly ? 'checked' : ''}> Weekdays only</label>
        </div>
        <p class="hint">Each stand-up is a paid run (usually a few cents). It only happens while Dev Crew is running.</p>`)}
      ${sec('general', 'Housekeeping', `<div class="grid3">
          <div class="field"><label>Remove finished worktrees after (days)</label><input type="number" name="worktreeDays" min="0" step="1" value="${hk.worktreeDays}"></div>
          <div class="field"><label>Archive tasks after (days)</label><input type="number" name="taskDays" min="0" step="1" value="${hk.taskDays}"></div>
          <label class="check"><input type="checkbox" name="hkAuto" ${hk.auto ? 'checked' : ''}> Clean up by itself once a week</label>
        </div>
        <p class="hint">Unmerged work, worktrees with uncommitted changes and anything a queued task needs are never touched. <a href="#" data-housekeeping>Open Housekeeping</a></p>`)}

      ${sec('roles', 'Roles', `<p class="hint">Every project gets these seats; turn them on or off per project in Edit project, and give each role notes about your code there. Here you change what a role is: its name, colour, whether it reads or changes code, and its instructions. Each role saves on its own.</p>
        <div id="roleCards">${roleCardsHtml(rolesData)}</div>
        <button type="button" class="btn" data-role-add>+ Add a role</button>`)}

      ${sec('permissions', 'Allowed commands', `<p class="hint">Agents that make changes may run the built-in build, test and git commands below, plus these, in every project. Projects can add their own in Edit project, and a task's panel offers to allow a command it was refused. Deleting, pushing, merging, downloading and chained commands are always refused.</p>
        <textarea name="allowCommands" hidden>${esc((e.allowCommands || []).join('\n'))}</textarea>
        <div class="perm-edit" id="permEdit"></div>
        <div class="row-inline"><input type="text" id="permNew" placeholder="e.g. npm run e2e" maxlength="60"><button type="button" class="btn sm" data-perm-add>Add</button></div>
        <div class="perm-presets"><span class="faint">Add a set for your stack:</span> ${Object.keys(PERMISSION_PRESETS).map(k => `<button type="button" class="chip-btn" data-perm-preset="${esc(k)}">${esc(k)}</button>`).join('')}</div>`)}
      ${sec('permissions', 'Built in <span class="faint">(read-only)</span>', `<details><summary>What agents may always run (${d.permissions.change.length} commands for changes, ${d.permissions.analyze.length} for read-only work)</summary>
          <h4>Make changes</h4><div class="perm-list">${chips(d.permissions.change)}</div>
          <h4>Conflict Fixer, in addition</h4><div class="perm-list">${chips(['git merge'])}</div>
          <h4>Investigate &amp; report</h4><div class="perm-list">${chips(d.permissions.analyze)}</div></details>
        <h4>Always refused</h4><div class="perm-list">${chips(d.permissions.denied)}</div>
        ${d.permissions.projects.some(p => p.extra.length) ? `<h4>Extra, per project</h4>${d.permissions.projects.filter(p => p.extra.length).map(p => `<div><b>${esc(p.name)}</b>: ${chips(p.extra)}</div>`).join('')}` : ''}`)}

      ${sec('integrations', 'Your integrations', `<p class="hint">Connect more tools. A <b>tool</b> is an MCP server the agents can use (Azure DevOps, a database, a browser, your own); a <b>notification</b> tells Slack, Teams or any URL when tasks finish or need you. Each one can be limited to some projects and roles.</p><div id="intBox"><p class="faint">Loading…</p></div>`)}
      ${sec('integrations', 'Connections', `<p class="hint">What Dev Crew uses on this machine, and whether it works.</p>
        <ul class="checks" id="checkList"><li class="faint">Checking…</li></ul>
        <button type="button" class="btn sm" data-recheck>Check again</button>`)}
      ${sec('integrations', 'monday.com', `${d.mondayTokenFromEnv ? '<p class="hint">A token is set in the <code>MONDAY_API_TOKEN</code> environment variable; it is used instead of the one below.</p>' : ''}
        <div class="grid3">
          <div class="field"><label>API token ${mon.tokenSet ? `<span class="faint">(saved, ends ${esc(mon.tokenHint)})</span>` : ''}</label><input type="password" name="mondayToken" autocomplete="off" placeholder="${mon.tokenSet ? 'Leave blank to keep the saved token' : 'Paste a token to connect'}"></div>
          <div class="field"><label>API version <span class="faint">(optional)</span></label><input type="text" name="mondayApiVersion" value="${esc(mon.apiVersion || '')}" placeholder="e.g. 2024-10"></div>
          ${mon.tokenSet ? '<label class="check"><input type="checkbox" name="mondayClear"> Remove the saved token</label>' : '<span></span>'}
        </div>
        <p class="hint">The token is stored in <code>crew.config.local.json</code> and never shown again here. Pick each project's board in Edit project.</p>`)}

      ${sec('appearance', 'Appearance', `<div class="set-rows">
          <div><label class="set-label">Theme</label>${seg('theme', ui.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']])}</div>
          <div><label class="set-label">Motion</label>${seg('motion', ui.motion, [['full', 'Full'], ['reduced', 'Reduced'], ['off', 'Off']])}<span class="hint">Reduced: agents stay at their desks. Off: nothing moves.</span></div>
          <div><label class="set-label">3D quality</label>${seg('quality', ui.quality, [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}<span class="hint">Lower it on slow laptops or remote desktops.</span></div>
          <div><label class="set-label">Office</label>${seg('officeView', ui.officeView, [['3d', '3D office'], ['2d', 'Simple 2D view']])}</div>
        </div>`)}

      ${sec('advanced', 'Running Dev Crew', `<div class="grid2">
          <div class="field"><label>Port</label><input type="number" name="port" min="1024" max="65535" value="${e.port}"><span class="hint">Takes effect after a restart.</span></div>
          <div class="field"><label>Workspace folder <span class="faint">(where project folders live)</span></label><input type="text" name="workspace" value="${esc(e.workspace || e.workspacePath)}"><span class="hint">Now: ${esc(e.workspacePath)}</span></div>
          <div class="field"><label>Claude command</label><input type="text" name="claudeCommand" value="${esc(e.claudeCommand)}"><span class="hint">${d.claude.found ? `Found: ${esc(d.claude.version)}` : '<span style="color:var(--red)">Not found</span>'}</span></div>
          <div class="field"><label>Permission mode</label><select name="permissionMode">${(e.permissionModes || ['']).map(v => opt(v, e.permissionMode, { '': 'Automatic (recommended)', default: 'default: ask (agents stop at any prompt)', acceptEdits: 'acceptEdits: allow file edits', dontAsk: 'dontAsk: refuse anything not allowed' }[v] || v)).join('')}</select><span class="hint">Automatic uses dontAsk when this Claude Code has it.</span></div>
        </div>
        <label class="check"><input type="checkbox" name="strictMcp" ${e.strictMcp ? 'checked' : ''}> Agents use no MCP servers except the ones Dev Crew gives them (strict MCP)</label>
        <label class="check"><input type="checkbox" name="inheritClaudeEnv" ${e.inheritClaudeEnv ? 'checked' : ''}> Pass a parent Claude session's variables to agents</label>`)}
      ${sec('advanced', 'Backups, export and import', `<p class="hint">Every save keeps the previous file. Restoring also keeps the current one first, so it can be undone. Export leaves out the monday.com token; import keeps this machine's token.</p>
        <div class="card-actions"><a class="btn sm" href="/api/config/export" download>Export settings</a><label class="btn sm file-btn">Import settings…<input type="file" id="importFile" accept=".json,application/json" hidden></label></div>
        <ul class="backups" id="backupList"><li class="faint">Loading backups…</li></ul>`)}

      <div class="set-save"><button class="btn primary" id="settingsSave">Save settings</button><span class="hint" id="settingsMsg"></span></div>
      <p class="empty set-none" hidden>No setting matches that search.</p>
    </form>`;

  // allowed commands as chips (stored in the hidden textarea, saved with the rest)
  const permBox = $('#settingsForm').elements.allowCommands;
  const permList = () => permBox.value.split('\n').map(x => x.trim()).filter(Boolean);
  const drawPerms = () => {
    const list = permList();
    $('#permEdit').innerHTML = list.length
      ? list.map(c => `<span class="perm-chip"><code>${esc(c)}</code><button type="button" class="icon-x" data-perm-del="${esc(c)}" aria-label="Remove ${esc(c)}">✕</button></span>`).join('')
      : '<span class="faint">None yet.</span>';
  };
  const addPerms = cmds => {
    const list = permList();
    for (const c of cmds) { const v = c.trim().replace(/\s+/g, ' '); if (v && !list.includes(v)) list.push(v); }
    permBox.value = list.join('\n');
    drawPerms();
    $('#settingsMsg').textContent = 'Not saved yet: press Save settings.';
  };
  drawPerms();
  loadChecks();
  loadIntegrations();
  loadBackups();

  const page = $('#settingsPage');
  page.addEventListener('click', async ev => {
    const t = ev.target.closest('[data-set-tab]');
    if (t) {
      settingsTab = t.dataset.setTab;
      $('#settingsForm').dataset.active = settingsTab;
      page.querySelectorAll('[data-set-tab]').forEach(b => { b.classList.toggle('active', b === t); b.toggleAttribute('aria-current', b === t); });
      $('#settingsSearch').value = '';
      filterSettings('');
      return;
    }
    if (ev.target.closest('[data-perm-add]')) { addPerms([$('#permNew').value]); $('#permNew').value = ''; return; }
    const pp = ev.target.closest('[data-perm-preset]');
    if (pp) { addPerms(PERMISSION_PRESETS[pp.dataset.permPreset]); return; }
    const pd = ev.target.closest('[data-perm-del]');
    if (pd) { permBox.value = permList().filter(c => c !== pd.dataset.permDel).join('\n'); drawPerms(); $('#settingsMsg').textContent = 'Not saved yet: press Save settings.'; return; }
    if (ev.target.closest('[data-recheck]')) { loadChecks(); return; }
    const rs = ev.target.closest('[data-restore]');
    if (rs) {
      if (!confirm(`Restore the settings saved ${rs.dataset.when}? The current file is kept as a backup first.`)) return;
      try { await api('/api/config/restore', { method: 'POST', body: { name: rs.dataset.restore } }); toast('Settings restored'); page.remove(); renderSettings($('#main')); }
      catch (err) { toast(err.message, true); }
      return;
    }
    // roles editor
    const re = ev.target.closest('[data-role-edit]');
    if (re) { openRoleEditor(rolesData, re.dataset.roleEdit); return; }
    if (ev.target.closest('[data-role-add]')) { openRoleEditor(rolesData, ''); return; }
    if (ev.target.closest('[data-role-cancel]')) { $('#roleCards').innerHTML = roleCardsHtml(rolesData); return; }
    const rr = ev.target.closest('[data-role-reset]');
    if (rr) {
      const r = rolesData.roles.find(x => x.id === rr.dataset.roleReset);
      const builtIn = !!rolesData.defaults[rr.dataset.roleReset];
      if (!confirm(builtIn ? `Reset the ${r.name} to Dev Crew's built-in version?` : `Remove the ${r.name} role? Projects stop using it; its past tasks stay.`)) return;
      try {
        await api(`/api/roles/${encodeURIComponent(rr.dataset.roleReset)}`, { method: 'DELETE' });
        rolesData = await api('/api/roles');
        $('#roleCards').innerHTML = roleCardsHtml(rolesData);
        toast(builtIn ? 'Role reset' : 'Role removed');
      }
      catch (err) { toast(err.message, true); }
      return;
    }
    const rsv = ev.target.closest('[data-role-save]');
    if (rsv) {
      const box = rsv.closest('.role-editor');
      const val = n => box.querySelector(`[name=${n}]`).value;
      const id = (val('r_id') || '').trim().toLowerCase();
      if (!id) return toast('Give the role an id', true);
      if (!val('r_name').trim() || !val('r_prompt').trim()) return toast('A role needs a name and instructions', true);
      rsv.disabled = true;
      try {
        await api(`/api/roles/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: val('r_name'), short: val('r_short'), color: val('r_color'), defaultMode: val('r_mode'), focus: val('r_focus'), prompt: val('r_prompt') } });
        rolesData = await api('/api/roles');
        $('#roleCards').innerHTML = roleCardsHtml(rolesData);
        toast('Role saved');
      } catch (err) { toast(err.message, true); rsv.disabled = false; }
    }
  });
  page.addEventListener('change', async ev => {
    if (ev.target.id !== 'importFile' || !ev.target.files[0]) return;
    let config;
    try { config = JSON.parse(await ev.target.files[0].text()); } catch { ev.target.value = ''; return toast('That file is not valid JSON', true); }
    const n = Array.isArray(config.projects) ? config.projects.length : 0;
    if (!confirm(`Replace your settings with this file (${n} project${n === 1 ? '' : 's'})? The current settings are kept as a backup and can be restored.`)) { ev.target.value = ''; return; }
    try { const r = await api('/api/config/import', { method: 'POST', body: { config } }); toast(`Imported: ${r.projects} project(s)`); page.remove(); renderSettings($('#main')); }
    catch (err) { toast(err.message, true); ev.target.value = ''; }
  });
  $('#settingsSearch').addEventListener('input', ev => filterSettings(ev.target.value));
  $('#permNew').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addPerms([ev.target.value]); ev.target.value = ''; } });

  const form = $('#settingsForm');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const F = form.elements;
    const radio = n => (form.querySelector(`input[name=${n}]:checked`) || {}).value;
    const body = {
      model: F.model.value, reportModel: F.reportModel.value, maxConcurrent: F.maxConcurrent.value,
      limits: { taskBudgetUsd: F.taskBudgetUsd.value, taskTimeoutMin: F.taskTimeoutMin.value, dailyBudgetUsd: F.dailyBudgetUsd.value, warnAtPercent: F.warnAtPercent.value },
      handoffs: radio('handoffs'),
      dailyReport: { enabled: F.drEnabled.checked, at: F.drAt.value, weekdaysOnly: F.drWeekdays.checked },
      housekeeping: { worktreeDays: F.worktreeDays.value, taskDays: F.taskDays.value, auto: F.hkAuto.checked },
      ui: { theme: radio('theme'), motion: radio('motion'), quality: radio('quality'), officeView: radio('officeView') },
      monday: { token: F.mondayToken.value, apiVersion: F.mondayApiVersion.value, clearToken: !!(F.mondayClear && F.mondayClear.checked) },
      advanced: { claudeCommand: F.claudeCommand.value, inheritClaudeEnv: F.inheritClaudeEnv.checked, port: F.port.value, workspace: F.workspace.value, permissionMode: F.permissionMode.value, strictMcp: F.strictMcp.checked },
      allowCommands: F.allowCommands.value,
    };
    const btn = $('#settingsSave');
    btn.disabled = true;
    try {
      const r = await api('/api/settings', { method: 'PUT', body });
      toast(r.restartNeeded ? `Saved. Restart Dev Crew to use port ${r.port}.` : 'Settings saved');
      $('#settingsPage').remove();
      renderSettings($('#main')); // show what was stored (e.g. the token hint)
    } catch (err) {
      $('#settingsMsg').textContent = err.message;
      toast('Not saved: see the message by the button', true);
    } finally {
      btn.disabled = false;
    }
  });
}

/** Search: show the sections (from every tab) whose text matches; empty search = the current tab. */
function filterSettings(q) {
  const form = $('#settingsForm');
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  form.classList.toggle('searching', words.length > 0);
  let any = false;
  form.querySelectorAll('.set-sec').forEach(s => {
    const hit = !words.length || words.every(w => s.textContent.toLowerCase().includes(w) || [...s.querySelectorAll('input,select,textarea')].some(i => (i.name || '').toLowerCase().includes(w)));
    s.classList.toggle('search-hit', words.length > 0 && hit);
    if (words.length && hit) any = true;
  });
  form.querySelector('.set-none').hidden = !words.length || any;
}

async function loadChecks() {
  const box = $('#checkList');
  if (!box) return;
  box.innerHTML = '<li class="faint">Checking…</li>';
  try {
    const { checks } = await api('/api/checks');
    if (!$('#checkList')) return;
    box.innerHTML = checks.map(c => `<li class="check-row ${c.ok ? 'ok' : 'bad'}"><span class="check-dot" aria-hidden="true"></span><div><b>${esc(c.name)}</b> <span class="sr-only">${c.ok ? 'working' : 'needs attention'}</span><div>${esc(c.detail || '')}</div><div class="faint">${esc(c.needed || '')}</div></div></li>`).join('');
  } catch (e) { box.innerHTML = `<li class="err-inline">${esc(e.message)}</li>`; }
}

async function loadBackups() {
  const box = $('#backupList');
  if (!box) return;
  try {
    const { backups } = await api('/api/config/backups');
    if (!$('#backupList')) return;
    box.innerHTML = backups.length
      ? backups.map(b => `<li><span>${fmtTime(b.at)} <span class="faint">· ${ago(b.at)} · ${b.projects} project${b.projects === 1 ? '' : 's'}</span></span><button type="button" class="btn sm ghost" data-restore="${esc(b.name)}" data-when="${esc(fmtTime(b.at))}">Restore</button></li>`).join('')
      : '<li class="faint">No backups yet: one is kept every time settings are saved.</li>';
  } catch (e) { box.innerHTML = `<li class="err-inline">${esc(e.message)}</li>`; }
}

/** The role cards in Settings → Crew & roles. */
function roleCardsHtml(data) {
  const changed = id => (data.overrides || []).some(o => o.id === id);
  return `<ul class="role-cards">${data.roles.map(r => {
    const builtIn = !!data.defaults[r.id];
    const tag = !builtIn ? '<span class="pill blue">Custom</span>' : changed(r.id) ? '<span class="pill amber">Changed</span>' : '';
    return `<li class="role-card" style="--rc:${r.color}">
      <span class="role-chip" style="--rc:${r.color}">${esc(r.short)}</span>
      <div class="grow"><b>${esc(r.name)}</b> ${tag}<div class="faint">${r.defaultMode === 'analyze' ? 'Reads and reports' : 'Changes code on its own branch'}${r.kind === 'review' ? ' · reviews branches and pull requests' : r.kind === 'conflicts' ? ' · may run git merge in its own worktree' : ''}${r.focus ? ` · ${esc(r.focus)}` : ''}</div></div>
      <button type="button" class="btn sm" data-role-edit="${esc(r.id)}">Edit</button>
    </li>`;
  }).join('')}</ul>`;
}

/** Edit one role (or add one when id is ''), in place of the cards. */
function openRoleEditor(data, id) {
  const r = id ? data.roles.find(x => x.id === id) : { id: '', name: '', short: '', color: '#64748b', defaultMode: 'change', focus: '', prompt: '' };
  const def = id && data.defaults[id];
  const changed = id && (data.overrides || []).some(o => o.id === id);
  $('#roleCards').innerHTML = `<div class="role-editor card">
    <div class="grid3">
      <div class="field"><label>Id</label><input type="text" name="r_id" value="${esc(r.id)}" ${id ? 'readonly' : 'placeholder="e.g. security" pattern="[a-z][a-z0-9-]*"'}></div>
      <div class="field"><label>Name</label><input type="text" name="r_name" maxlength="60" value="${esc(r.name)}" placeholder="e.g. Security Engineer"></div>
      <div class="field"><label>Short tag</label><input type="text" name="r_short" maxlength="5" value="${esc(r.short)}" placeholder="SEC"></div>
      <div class="field"><label>Colour</label><input type="color" name="r_color" value="${esc(r.color)}"></div>
      <div class="field"><label>Usually</label><select name="r_mode"><option value="change" ${r.defaultMode === 'change' ? 'selected' : ''}>Changes code</option><option value="analyze" ${r.defaultMode === 'analyze' ? 'selected' : ''}>Reads and reports</option></select></div>
      <div class="field"><label>Focus <span class="faint">(one line)</span></label><input type="text" name="r_focus" maxlength="200" value="${esc(r.focus || '')}"></div>
    </div>
    <div class="field"><label>Instructions <span class="faint">(what this specialist knows and how they work; your project's notes are added after)</span></label><textarea name="r_prompt" rows="14" maxlength="4000">${esc(r.prompt || '')}</textarea></div>
    <div class="card-actions">
      <button type="button" class="btn primary" data-role-save>Save role</button>
      <button type="button" class="btn ghost" data-role-cancel>Cancel</button>
      <span class="grow"></span>
      ${def && changed ? `<button type="button" class="btn ghost" data-role-reset="${esc(id)}">Reset to built-in</button>` : ''}
      ${id && !def ? `<button type="button" class="btn ghost danger" data-role-reset="${esc(id)}">Remove role</button>` : ''}
    </div>
  </div>`;
  $('#roleCards').querySelector(id ? '[name=r_name]' : '[name=r_id]').focus();
}

/* ---------------- Settings → Integrations: tools and notifications you add ---------------- */

const intUi = { data: null };
const SECRET = '__set__';

async function loadIntegrations() {
  const box = $('#intBox');
  if (!box) return;
  try { intUi.data = await api('/api/integrations'); } catch (e) { box.innerHTML = `<p class="err-inline">${esc(e.message)}</p>`; return; }
  if (!$('#intBox')) return;
  drawIntegrations();
  if (!box.dataset.wired) { box.dataset.wired = '1'; box.addEventListener('click', onIntegrationClick); }
}

function drawIntegrations() {
  const d = intUi.data;
  const list = d.integrations;
  const scopeText = i => `${i.projects === '*' ? 'every project' : (i.projects || []).map(id => (d.projects.find(p => p.id === id) || { name: id }).name).join(', ')}${i.type === 'mcp' ? ` · ${i.roles === '*' ? 'every role' : (i.roles || []).map(id => (d.roles.find(r => r.id === id) || { name: id }).name).join(', ')}${i.readOnlyTasks ? '' : ' · tasks that make changes'}` : ` · tells you when: ${(i.events || []).join(', ')}`}`;
  $('#intBox').innerHTML = `${list.length ? `<ul class="int-list">${list.map(i => `<li class="int-row ${i.enabled === false ? 'off' : ''}">
      <span class="int-kind">${i.type === 'mcp' ? 'Tool' : 'Notify'}</span>
      <div class="grow"><b>${esc(i.name)}</b> ${i.enabled === false ? '<span class="pill">Off</span>' : ''}<div class="faint">${i.type === 'mcp' ? (i.transport === 'http' ? esc(i.url) : esc([i.command, ...(i.args || [])].join(' '))) : esc(i.format)} · ${esc(scopeText(i))}</div><div class="int-test" data-int-result="${esc(i.id)}"></div></div>
      <button type="button" class="btn sm ghost" data-int-test="${esc(i.id)}">Test</button>
      <button type="button" class="btn sm ghost" data-int-toggle="${esc(i.id)}">${i.enabled === false ? 'Turn on' : 'Turn off'}</button>
      <button type="button" class="btn sm" data-int-edit="${esc(i.id)}">Edit</button>
    </li>`).join('')}</ul>` : '<p class="faint">Nothing added yet.</p>'}
    <button type="button" class="btn" data-int-add>+ Add integration</button>`;
}

function intPickerHtml() {
  return `<div class="int-picker"><p class="hint">Pick a starting point; you can change everything on the next screen.</p>
    <div class="int-presets">${intUi.data.presets.map(p => `<button type="button" class="int-preset" data-int-preset="${esc(p.key)}"><b>${esc(p.name)}</b><span class="int-kind">${p.type === 'mcp' ? 'Tool for agents' : 'Notification'}</span><span class="faint">${esc(p.about)}</span></button>`).join('')}</div>
    <button type="button" class="btn ghost" data-int-cancel>Cancel</button></div>`;
}

const kvRows = (name, obj) => {
  const rows = Object.entries(obj || {});
  return `<div class="kv-rows" data-kv="${name}">${rows.map(([k, v]) => kvRow(k, v)).join('')}${kvRow('', '')}</div>
    <button type="button" class="linkish" data-kv-add="${name}">+ Add another</button>`;
};
const kvRow = (k, v) => `<div class="kv-row"><input type="text" class="kv-k" placeholder="NAME" value="${esc(k)}"><input type="password" class="kv-v" autocomplete="off" placeholder="${v === SECRET ? 'saved: leave blank to keep' : 'value'}" value="${v === SECRET ? '' : esc(v)}" data-saved="${v === SECRET ? '1' : ''}"></div>`;

function intEditorHtml(i) {
  const d = intUi.data;
  const isNew = !i.id;
  const checks = (name, all, chosen) => `<div class="int-checks"><label class="check"><input type="checkbox" data-all="${name}" ${chosen === '*' || !chosen ? 'checked' : ''}> All</label>${all.map(x => `<label class="check"><input type="checkbox" name="${name}" value="${esc(x.id)}" ${Array.isArray(chosen) && chosen.includes(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div>`;
  const mcp = i.type === 'mcp';
  return `<div class="int-editor card" data-int-id="${esc(i.id || '')}" data-int-type="${esc(i.type)}">
    <div class="grid2">
      <div class="field"><label>Name</label><input type="text" name="i_name" maxlength="60" value="${esc(i.name || '')}"></div>
      ${mcp ? `<div class="field"><label>Connects with</label><select name="i_transport"><option value="stdio" ${i.transport !== 'http' ? 'selected' : ''}>A command on this machine</option><option value="http" ${i.transport === 'http' ? 'selected' : ''}>A URL (HTTP)</option></select></div>`
        : `<div class="field"><label>Message format</label><select name="i_format">${[['slack', 'Slack'], ['teams', 'Microsoft Teams'], ['json', 'JSON']].map(([v, l]) => `<option value="${v}" ${i.format === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`}
    </div>
    ${mcp ? `<div class="int-stdio" ${i.transport === 'http' ? 'hidden' : ''}>
        <div class="grid2"><div class="field"><label>Command</label><input type="text" name="i_command" value="${esc(i.command || '')}" placeholder="npx"></div>
        <div class="field"><label>Arguments <span class="faint">(one per line)</span></label><textarea name="i_args" rows="3">${esc((i.args || []).join('\n'))}</textarea></div></div>
        <div class="field"><label>Environment variables <span class="faint">(tokens and keys go here; stored in the local config, never shown again)</span></label>${kvRows('env', i.env)}</div>
      </div>
      <div class="int-http" ${i.transport === 'http' ? '' : 'hidden'}>
        <div class="field"><label>URL</label><input type="text" name="i_url" value="${esc(i.url || '')}" placeholder="https://…"></div>
        <div class="field"><label>Headers <span class="faint">(for example Authorization: Bearer …; stored, never shown again)</span></label>${kvRows('headers', i.headers)}</div>
      </div>
      <div class="field"><label>Only these tools <span class="faint">(optional, comma-separated; blank allows every tool the server offers)</span></label><input type="text" name="i_tools" value="${esc((i.tools || []).join(', '))}"></div>
      <div class="field"><label>Notes for the agents <span class="faint">(optional: when and how to use it)</span></label><textarea name="i_notes" rows="2" maxlength="1500" placeholder="e.g. Our Azure DevOps project is DataEz; link work items as AB#123 in commit messages.">${esc(i.notes || '')}</textarea></div>
      <div class="field"><label>Roles that get it</label>${checks('i_roles', d.roles, i.roles)}</div>
      <label class="check"><input type="checkbox" name="i_readonly" ${i.readOnlyTasks ? 'checked' : ''}> Also in read-only tasks (investigations, reviews). Leave off for tools that can change things.</label>`
    : `<div class="field"><label>Webhook URL <span class="faint">(stored, never shown again)</span></label><input type="password" name="i_url" autocomplete="off" value="${i.url && i.url !== SECRET ? esc(i.url) : ''}" placeholder="${i.url === SECRET ? 'saved: leave blank to keep' : 'https://…'}"></div>
      <div class="field"><label>Tell me when</label><div class="int-checks">${[['review', 'A branch is ready for review'], ['plan', 'A plan is ready to start'], ['failed', 'A task failed or stopped'], ['done', 'Any task finished']].map(([v, l]) => `<label class="check"><input type="checkbox" name="i_events" value="${v}" ${(i.events || ['review', 'failed', 'plan']).includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>`}
    <div class="field"><label>Projects</label>${checks('i_projects', d.projects, i.projects)}</div>
    <label class="check"><input type="checkbox" name="i_enabled" ${i.enabled === false ? '' : 'checked'}> On</label>
    <div class="int-test" data-int-result="__editor"></div>
    <div class="card-actions">
      <button type="button" class="btn primary" data-int-save>${isNew ? 'Add integration' : 'Save'}</button>
      <button type="button" class="btn" data-int-test-form>Test</button>
      <button type="button" class="btn ghost" data-int-cancel>Cancel</button>
      <span class="grow"></span>
      ${isNew ? '' : `<button type="button" class="btn ghost danger" data-int-remove="${esc(i.id)}">Remove</button>`}
    </div>
    ${mcp ? '<p class="hint">Agents can use every tool you allow here, on the systems it reaches. Prefer read-only access, test systems and tokens with few rights.</p>' : ''}
  </div>`;
}

/** Read the editor into the shape the server expects. */
function intFormFromEditor(box) {
  const v = n => (box.querySelector(`[name=${n}]`) || {}).value;
  const picked = n => (box.querySelector(`[data-all=${n}]`) || {}).checked ? [] : [...box.querySelectorAll(`[name=${n}]:checked`)].map(x => x.value);
  const kv = name => [...box.querySelectorAll(`[data-kv=${name}] .kv-row`)].map(r => ({ key: r.querySelector('.kv-k').value.trim(), value: r.querySelector('.kv-v').value || (r.querySelector('.kv-v').dataset.saved ? SECRET : '') })).filter(p => p.key);
  const type = box.dataset.intType;
  const form = { type, name: v('i_name'), projects: picked('i_projects'), enabled: box.querySelector('[name=i_enabled]').checked };
  if (type === 'mcp') {
    Object.assign(form, { transport: v('i_transport'), command: v('i_command'), args: v('i_args'), env: kv('env'), url: v('i_url'), headers: kv('headers'), tools: v('i_tools'), notes: v('i_notes'), roles: picked('i_roles'), readOnlyTasks: box.querySelector('[name=i_readonly]').checked });
  } else {
    Object.assign(form, { format: v('i_format'), url: v('i_url') || (box.dataset.intId ? SECRET : ''), events: [...box.querySelectorAll('[name=i_events]:checked')].map(x => x.value) });
  }
  return form;
}

function showIntResult(key, r) {
  const el = document.querySelector(`[data-int-result="${key}"]`);
  if (!el) return;
  el.className = `int-test ${r.ok ? 'ok-text' : 'err-inline'}`;
  el.textContent = r.ok ? `${r.detail}${r.tools && r.tools.length ? `: ${r.tools.slice(0, 30).join(', ')}${r.tools.length > 30 ? ' …' : ''}` : ''}` : `Not working: ${r.detail || r.error}`;
}

async function onIntegrationClick(e) {
  const t = e.target;
  const box = t.closest('.int-editor');
  if (t.closest('[data-int-add]')) { $('#intBox').innerHTML = intPickerHtml(); return; }
  if (t.closest('[data-int-cancel]')) { drawIntegrations(); return; }
  const pr = t.closest('[data-int-preset]');
  if (pr) {
    const p = intUi.data.presets.find(x => x.key === pr.dataset.intPreset);
    $('#intBox').innerHTML = intEditorHtml({ ...p, id: '', projects: '*', roles: '*', enabled: true });
    return;
  }
  const ed = t.closest('[data-int-edit]');
  if (ed) { $('#intBox').innerHTML = intEditorHtml(intUi.data.integrations.find(i => i.id === ed.dataset.intEdit)); return; }
  const ka = t.closest('[data-kv-add]');
  if (ka) { box.querySelector(`[data-kv=${ka.dataset.kvAdd}]`).insertAdjacentHTML('beforeend', kvRow('', '')); return; }
  const tg = t.closest('[data-int-toggle]');
  if (tg) {
    const i = intUi.data.integrations.find(x => x.id === tg.dataset.intToggle);
    try { const r = await api(`/api/integrations/${encodeURIComponent(i.id)}`, { method: 'PUT', body: { ...i, enabled: i.enabled === false } }); intUi.data.integrations = r.integrations; drawIntegrations(); toast(i.enabled === false ? `${i.name} is on` : `${i.name} is off`); }
    catch (err) { toast(err.message, true); }
    return;
  }
  const ts = t.closest('[data-int-test]');
  if (ts) {
    const i = intUi.data.integrations.find(x => x.id === ts.dataset.intTest);
    ts.disabled = true;
    showIntResult(i.id, { ok: true, detail: 'Testing… (starting a server can take up to a minute)' });
    try { showIntResult(i.id, await api('/api/integrations/test', { method: 'POST', body: { form: i, id: i.id } })); }
    catch (err) { showIntResult(i.id, { ok: false, detail: err.message }); }
    ts.disabled = false;
    return;
  }
  if (t.closest('[data-int-test-form]')) {
    const btn = t.closest('[data-int-test-form]');
    btn.disabled = true;
    showIntResult('__editor', { ok: true, detail: 'Testing… (starting a server can take up to a minute)' });
    try { showIntResult('__editor', await api('/api/integrations/test', { method: 'POST', body: { form: intFormFromEditor(box), id: box.dataset.intId || '' } })); }
    catch (err) { showIntResult('__editor', { ok: false, detail: err.message }); }
    btn.disabled = false;
    return;
  }
  if (t.closest('[data-int-save]')) {
    const id = box.dataset.intId;
    try {
      const r = await api(`/api/integrations/${id ? encodeURIComponent(id) : '_new'}`, { method: 'PUT', body: intFormFromEditor(box) });
      intUi.data.integrations = r.integrations;
      drawIntegrations();
      toast(id ? 'Integration saved' : 'Integration added');
    } catch (err) { showIntResult('__editor', { ok: false, detail: err.message }); }
    return;
  }
  const rm = t.closest('[data-int-remove]');
  if (rm) {
    const i = intUi.data.integrations.find(x => x.id === rm.dataset.intRemove);
    if (!confirm(`Remove ${i.name}? Agents stop getting it straight away; its saved secrets are deleted from the config.`)) return;
    try { const r = await api(`/api/integrations/${encodeURIComponent(i.id)}`, { method: 'DELETE' }); intUi.data.integrations = r.integrations; drawIntegrations(); toast(`${i.name} removed`); }
    catch (err) { toast(err.message, true); }
  }
}

// the editor's small dynamics: transport switch, and "All" versus single checkboxes
document.addEventListener('change', e => {
  const box = e.target.closest && e.target.closest('.int-editor');
  if (!box) return;
  if (e.target.name === 'i_transport') {
    box.querySelector('.int-stdio').hidden = e.target.value === 'http';
    box.querySelector('.int-http').hidden = e.target.value !== 'http';
  }
  if (e.target.dataset.all && e.target.checked) box.querySelectorAll(`[name=${e.target.dataset.all}]`).forEach(c => { c.checked = false; });
  if (/^i_(projects|roles)$/.test(e.target.name) && e.target.checked) { const all = box.querySelector(`[data-all=${e.target.name}]`); if (all) all.checked = false; }
});

/* ---------------- alerts: top right in the page, or system notifications ---------------- */

const ALERT_KEY = 'devcrew.alerts';
function alertPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(ALERT_KEY) || '{}') || {}; } catch { /* private window */ }
  return { ...ALERT_DEFAULTS, ...saved, events: { ...ALERT_DEFAULTS.events, ...(saved.events || {}) } };
}
function saveAlertPrefs(p) { try { localStorage.setItem(ALERT_KEY, JSON.stringify(p)); } catch { /* not remembered */ } }

const alertSeen = new Set();
function raiseAlerts(prev, t) {
  const prefs = alertPrefs();
  const list = detectAlerts(prev, t, {
    roleName: id => roleOf(id).name,
    projectName: id => (projOf(id) || {}).name || id,
    hasReviewer: pid => crewRoles(projOf(pid)).some(r => r.kind === 'review'),
  });
  for (const a of list) {
    if (!prefs.events[a.event] || alertSeen.has(a.key)) continue;
    alertSeen.add(a.key);
    deliverAlert(a, prefs);
  }
}

/** In the page when you are looking at it; as a system notification when it is in the background. */
async function deliverAlert(a, prefs = alertPrefs(), { test = false } = {}) {
  const away = document.visibilityState !== 'visible' || !document.hasFocus();
  const serverToasts = !test && serverToastsOn();
  if (away && serverToasts) return; // the Dev Crew server shows a Windows notification instead
  if (prefs.system && away && !serverToasts && 'Notification' in window && Notification.permission === 'granted' && await showSystemAlert(a)) return;
  if (prefs.inApp) showInAppAlert(a);
}
const serverToastsOn = () => !!(S && S.settings.desktopAlerts && S.settings.desktopAlerts.enabled && S.settings.desktopAlerts.supported);

// Tell the server whether you are looking at Dev Crew, so it does not also send a Windows
// notification for something already on your screen.
let presenceSent = null;
function sendPresence() {
  const v = document.visibilityState === 'visible' && document.hasFocus();
  if (v === presenceSent && !v) return;
  presenceSent = v;
  fetch('/api/presence', { method: 'POST', headers: { 'x-dev-crew': '1', 'content-type': 'application/json' }, body: JSON.stringify({ visible: v }), keepalive: true }).catch(() => {});
}
['visibilitychange', 'focus', 'blur'].forEach(ev => window.addEventListener(ev, sendPresence));
setInterval(() => { if (document.visibilityState === 'visible' && document.hasFocus()) { presenceSent = null; sendPresence(); } }, 25000);

async function showSystemAlert(a) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const abs = u => (u ? new URL(u, location.href).href : undefined);
    await reg.showNotification(a.title, {
      body: a.body,
      tag: a.key,
      icon: '/icon.svg',
      badge: '/icon.svg',
      requireInteraction: ['review', 'plan', 'handoff'].includes(a.event),
      actions: a.actions.slice(0, 2).map(x => ({ action: x.id, title: x.label })),
      data: { url: abs(a.url), actions: Object.fromEntries(a.actions.map(x => [x.id, { ...x, url: abs(x.url) }])) },
    });
    return true;
  } catch { return false; }
}

function showInAppAlert(a) {
  const box = $('#alerts');
  if (!box) return;
  while (box.children.length >= 4) box.lastElementChild.remove();
  const card = document.createElement('div');
  card.className = `alert-card ev-${a.event}`;
  card.setAttribute('role', 'status');
  card.innerHTML = `<div class="alert-top"><b>${esc(a.title)}</b><button class="icon-x" aria-label="Dismiss">✕</button></div>
    <div class="alert-body">${esc(a.body)}</div>
    <div class="alert-acts">${a.actions.map((x, i) => `<button class="btn sm ${i === 0 ? 'primary' : ''}" data-alert-act="${esc(x.id)}">${esc(x.label)}</button>`).join('')}</div>`;
  box.prepend(card);
  let timer = setTimeout(() => card.remove(), 20000);
  card.addEventListener('mouseenter', () => clearTimeout(timer));
  card.addEventListener('mouseleave', () => { timer = setTimeout(() => card.remove(), 8000); });
  card.addEventListener('click', async e => {
    if (e.target.closest('.icon-x')) return card.remove();
    const b = e.target.closest('[data-alert-act]');
    if (!b) return;
    const act = a.actions.find(x => x.id === b.dataset.alertAct);
    if (act.kind === 'open') { card.remove(); location.hash = act.url.replace(/^#/, '') ? act.url : '#/today'; return; }
    b.disabled = true;
    try { await api(act.path, { method: act.method || 'POST', body: act.body || {} }); toast(act.doneText || 'Done'); card.remove(); }
    catch (err) { toast(err.message, true); b.disabled = false; }
  });
}

/** #/t/<task id>[/review]: open that task on its project's page (from an alert or a notification). */
function openTaskLink() {
  const m = /^#\/t\/([\w-]+)(?:\/(\w+))?/.exec(location.hash);
  if (!m || !S) return false;
  const t = S.tasks.find(x => x.id === m[1]);
  if (!t) { location.replace('#/today'); return true; }
  history.replaceState(null, '', `#/p/${t.projectId}/tasks`);
  closeDrawer();
  render();
  openDrawer('task', t.id);
  if (m[2] === 'review') {
    const rev = crewRoles(projOf(t.projectId)).find(r => r.kind === 'review');
    if (rev && t.branch) openAssign({ projectId: t.projectId, role: rev.id, repo: t.repo, reviewBranch: t.branch, reviewBase: t.base });
  }
  return true;
}

/** The Alerts section in Settings → General (saved in this browser). */
function alertSettingsHtml() {
  const p = alertPrefs();
  const perm = !('Notification' in window) ? 'unsupported' : Notification.permission;
  const d = (S && S.settings.desktopAlerts) || {};
  return `<p class="hint">Dev Crew tells you when something needs you, with what happened and buttons to act on it (Review, Start plan, Start handoff).</p>
    <label class="check"><input type="checkbox" data-desktop-alerts ${d.enabled ? 'checked' : ''} ${d.supported ? '' : 'disabled'}> <b>Windows notifications from Dev Crew itself</b>: they arrive while you work on something else, even with the browser minimised or closed (Dev Crew must be running)</label>
    ${d.supported ? '<div class="card-actions" style="margin:2px 0 10px"><button type="button" class="btn sm" data-desktop-test>Send a test Windows notification</button><span class="hint">If nothing appears, check Windows Settings → System → Notifications (and Do not disturb / Focus).</span></div>' : '<p class="hint">Windows notifications need Dev Crew running on Windows.</p>'}
    <label class="check"><input type="checkbox" data-alert-pref="inApp" ${p.inApp ? 'checked' : ''}> Show alerts in Dev Crew (top right) while you are looking at it</label>
    <label class="check"><input type="checkbox" data-alert-pref="system" ${p.system && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' || perm === 'denied' || d.enabled ? 'disabled' : ''}> Browser notifications instead ${d.enabled ? '(not needed: Windows notifications are on)' : '(needs a Dev Crew tab open)'}</label>
    <p class="hint" id="alertPerm" ${d.enabled ? 'hidden' : ''}>${perm === 'denied' ? 'Notifications are blocked for this site: allow them in the browser\'s site settings (the icon left of the address), then reload.' : perm === 'unsupported' ? 'This browser has no system notifications.' : perm === 'default' ? 'The browser will ask for permission when you turn this on.' : 'Allowed in this browser.'} Keep a Dev Crew tab open (it can be minimised); notifications come from that tab.</p>
    <div class="int-checks">${ALERT_EVENTS.map(([k, l]) => `<label class="check"><input type="checkbox" data-alert-ev="${k}" ${p.events[k] ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
    <div class="card-actions" style="margin-top:8px"><button type="button" class="btn sm" data-alert-test>Send a test in-page alert</button><span class="hint">Shows at the top right of Dev Crew.</span></div>`;
}

document.addEventListener('change', async e => {
  const pref = e.target.dataset && e.target.dataset.alertPref;
  const ev = e.target.dataset && e.target.dataset.alertEv;
  if (!pref && !ev) return;
  const p = alertPrefs();
  if (ev) {
    p.events[ev] = e.target.checked;
    api('/api/settings', { method: 'PUT', body: { desktopAlerts: { events: { [ev]: e.target.checked } } } }).catch(err => toast(err.message, true));
  }
  if (pref === 'inApp') p.inApp = e.target.checked;
  if (pref === 'system') {
    if (e.target.checked && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission();
      if (r !== 'granted') { e.target.checked = false; toast('Notifications were not allowed', true); $('#alertPerm').textContent = r === 'denied' ? 'Notifications are blocked for this site: allow them in the browser\'s site settings, then reload.' : 'Not allowed yet.'; return; }
      $('#alertPerm').textContent = 'Allowed in this browser. Keep a Dev Crew tab open (it can be minimised); notifications come from that tab.';
    }
    p.system = e.target.checked;
  }
  saveAlertPrefs(p);
  toast('Saved in this browser');
});
document.addEventListener('change', async e => {
  if (!e.target.matches || !e.target.matches('[data-desktop-alerts]')) return;
  try {
    await api('/api/settings', { method: 'PUT', body: { desktopAlerts: { enabled: e.target.checked } } });
    if (S) S.settings.desktopAlerts = { ...S.settings.desktopAlerts, enabled: e.target.checked };
    toast(e.target.checked ? 'Windows notifications on' : 'Windows notifications off');
  } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
});
document.addEventListener('click', async e => {
  if (!e.target.closest('[data-desktop-test]')) return;
  try { await api('/api/alerts/test', { method: 'POST' }); toast('Test notification sent: look at the bottom right of your screen'); }
  catch (err) { toast(`Could not show it: ${err.message}`, true); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('[data-alert-test]')) return;
  const sample = { key: `test:${Date.now()}`, event: 'review', taskId: '', url: '#/today', title: 'Ready for review: Add paging to GET /invoices', body: 'Backend Engineer on DataEz · 2 commits · 3 files changed (a test alert)', actions: [{ id: 'open', label: 'Review', kind: 'open', url: '#/today' }, { id: 'later', label: 'Later', kind: 'open', url: '#/today' }] };
  toast('Test alert in 4 seconds');
  setTimeout(() => deliverAlert(sample, alertPrefs(), { test: true }), 4000);
});

/* ---------------- project editor (add / edit) ---------------- */

const MODELS = [['', 'Default'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];

/** Add (projectId null: pick a folder first) or edit a project's settings. */
async function openProjectEditor(projectId) {
  const dlg = $('#cfgDlg');
  if (!projectId) return browseFolder(dlg, '');
  try {
    const c = await api(`/api/projects/${encodeURIComponent(projectId)}/config`);
    projectForm(dlg, { ...c.project, folderPath: c.folderPath, repoNames: c.repos }, projectId);
  } catch (e) {
    toast(e.message, true);
  }
}

async function browseFolder(dlg, dir) {
  let b;
  try { b = await api(`/api/browse?dir=${encodeURIComponent(dir)}`); } catch (e) { return toast(e.message, true); }
  dlg.innerHTML = `<form method="dialog" id="cfgForm">
    <div class="m-head"><h2>Add a project</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <p class="hint">Pick the folder that holds the project's git repos (or a repo itself). Dev Crew looks at the files to suggest the stack and the roles; nothing is changed.</p>
      <div class="crumb"><code>${esc(b.dir)}</code>${b.parent ? ` <button type="button" class="btn sm ghost" data-browse="${esc(b.parent)}">↑ Up</button>` : ''}</div>
      <div class="folder-list">${b.entries.length ? b.entries.map(e => `
        <div class="folder-row">
          <button type="button" class="linkish" data-browse="${esc(e.path)}">📁 ${esc(e.name)}</button>
          <span class="faint">${e.repos ? `${e.repos} git repo${e.repos === 1 ? '' : 's'}` : 'no git repo'}${e.usedBy ? ` · already the project “${esc(e.usedBy)}”` : ''}</span>
          ${e.repos ? `<button type="button" class="btn sm" data-pick-folder="${esc(e.path)}">Use this</button>` : ''}
        </div>`).join('') : '<div class="empty">No sub-folders here.</div>'}</div>
      <div class="field"><label>Or type a folder path</label><div class="row-inline"><input type="text" id="folderPath" placeholder="C:\\Work\\billing" value=""><button type="button" class="btn" data-pick-folder="">Use this</button></div></div>
    </div>
    <div class="m-foot"><span></span><div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button></div></div>
  </form>`;
  if (!dlg.open) dlg.showModal();
  dlg.onclick = async e => {
    const br = e.target.closest('[data-browse]');
    if (br) return browseFolder(dlg, br.dataset.browse);
    const pk = e.target.closest('[data-pick-folder]');
    if (!pk) return;
    const folder = pk.dataset.pickFolder || ($('#folderPath').value || '').trim();
    if (!folder) return toast('Type a folder path first', true);
    pk.disabled = true;
    pk.textContent = 'Looking…';
    try {
      const d = await api('/api/detect', { method: 'POST', body: { folder } });
      if (!d.repos.length) { toast('No git repos found in that folder', true); pk.disabled = false; pk.textContent = 'Use this'; return; }
      projectForm(dlg, { ...d, folderPath: d.folder, repoNames: d.repos.map(r => r.name), detected: d }, null);
    } catch (err) {
      toast(err.message, true);
      pk.disabled = false;
      pk.textContent = 'Use this';
    }
  };
}

function projectForm(dlg, p, oldId) {
  const isNew = !oldId;
  const active = new Set(p.activeRoles && p.activeRoles.length ? p.activeRoles : S.roles.map(r => r.id));
  const repoOpts = sel => ['', ...(p.repoNames || [])].map(n => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${n ? esc(n) : '—'}</option>`).join('');
  const lim = p.limits || {};
  const roleRows = S.roles.map(r => {
    const rc = (p.roles || {})[r.id] || {};
    return `<div class="role-row" style="--rc:${r.color}">
      <label class="check"><input type="checkbox" name="active" value="${r.id}" ${active.has(r.id) ? 'checked' : ''}> <span class="role-chip" style="--rc:${r.color}">${esc(r.short)}</span> <b>${esc(r.name)}</b></label>
      <div class="role-fields">
        <label>Repo <select name="repo_${r.id}">${repoOpts(rc.repo || '')}</select></label>
        <label>Model <select name="model_${r.id}">${MODELS.map(([v, l]) => `<option value="${v}" ${v === (rc.model || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label title="Cost limit per run for this role (USD). Blank: the project's or the app's.">$ <input type="number" class="lim-in" name="rlb_${r.id}" min="0" step="0.5" placeholder="limit" value="${(rc.limits || {}).taskBudgetUsd ?? ''}"></label>
        <label title="Time limit per run for this role (minutes). Blank: the project's or the app's."><input type="number" class="lim-in" name="rlt_${r.id}" min="0" step="5" placeholder="min" value="${(rc.limits || {}).taskTimeoutMin ?? ''}"> min</label>
        <details ${rc.notes ? 'open' : ''}><summary>Notes for this role</summary><textarea name="notes_${r.id}" rows="2" placeholder="Standing instructions, e.g. where migrations live">${esc(rc.notes || '')}</textarea></details>
      </div>
    </div>`;
  }).join('');
  dlg.innerHTML = `<form method="dialog" id="cfgForm">
    <div class="m-head"><h2>${isNew ? 'Add a project' : `Edit ${esc(p.name)}`}</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      ${p.detected ? `<div class="linked">Found ${p.detected.repos.length} repo(s): ${p.detected.repos.map(r => `<b>${esc(r.name)}</b>${r.stack.length ? ` (${esc(r.stack.slice(0, 4).join(', '))}${r.stack.length > 4 ? '…' : ''})` : ''}`).join('; ')}. Check the suggestions below.</div>` : ''}
      <div class="grid2">
        <div class="field"><label>Name</label><input type="text" name="name" required maxlength="80" value="${esc(p.name || '')}"></div>
        <div class="field"><label>Id <span class="faint">(lower-case, digits, dashes)</span></label><input type="text" name="id" required pattern="[a-z0-9][a-z0-9-]*" maxlength="40" value="${esc(p.id || '')}"></div>
      </div>
      <div class="field"><label>Folder</label><input type="text" name="folder" value="${esc(p.folderPath || p.folder || '')}" ${isNew ? 'readonly' : ''}></div>
      <div class="field"><label>Tech stack <span class="faint">(every agent reads this; be specific)</span></label><textarea name="stack" rows="2">${esc(p.stack || '')}</textarea></div>
      <div class="field"><label>Context <span class="faint">(what the project is for, how you work)</span></label><textarea name="context" rows="3">${esc(p.context || '')}</textarea></div>
      <div class="field"><label>Crew <span class="faint">(untick roles this project does not need: they get no desk and no work)</span></label><div class="role-rows">${roleRows}</div></div>
      <div class="grid2">
        <div class="field"><label>Handoffs</label><select name="handoffs">
          ${[['', `App default (${esc(S.settings.handoffs || 'ask')})`], ['ask', 'Ask me first'], ['auto', 'Start automatically'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${v === (p.handoffs || '') ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
        <div class="field"><label>Extra allowed commands <span class="faint">(one per line)</span></label><textarea name="allowCommands" rows="2" placeholder="npm run e2e">${esc((p.allowCommands || []).join('\n'))}</textarea></div>
      </div>
      <div class="field"><label>Knowledge graph <span class="faint">(from graphify; ${(() => { const g = Object.entries(p.graphs || {}); const have = g.filter(([, v]) => v).map(([k]) => k); return !g.length ? 'save the project first' : have.length ? `found in ${esc(have.join(', '))}` : 'no repo has a graphify-out folder yet: run graphify in it first'; })()})</span></label><select name="knowledgeGraph">
        ${[['off', 'Off'], ['summary', 'Digest in the prompt (about 1,500 extra tokens a run)'], ['tools', 'Graph tools the agent can query (graphify-mcp)']].map(([v, l]) => `<option value="${v}" ${v === (p.knowledgeGraph || 'off') ? 'selected' : ''}>${l}</option>`).join('')}
      </select><span class="hint">Measure before you keep it on: compare the same kind of task with and without it on the Costs page.</span></div>
      ${qualityFields(p)}
      <div class="field"><label>monday.com board <span class="faint">(its tickets show on the agent cards)</span></label><select name="mondayBoardId" id="mondayBoard"><option value="${esc((p.monday || {}).boardId || '')}">${(p.monday || {}).boardId ? `Board ${esc(p.monday.boardId)}` : 'None'}</option></select><span class="hint" id="mondayBoardHint">Loading your boards…</span></div>
      <div class="grid2">
        <div class="field"><label>Cost limit per run for this project <span class="faint">(USD, blank = app default)</span></label><input type="number" name="lim_budget" min="0" step="0.5" value="${lim.taskBudgetUsd ?? ''}"></div>
        <div class="field"><label>Time limit per run <span class="faint">(minutes, blank = app default)</span></label><input type="number" name="lim_time" min="0" step="5" value="${lim.taskTimeoutMin ?? ''}"></div>
      </div>
      <p class="hint">Saved to <code>crew.config.local.json</code>. The previous version is kept in <code>data/config-backups</code>.</p>
    </div>
    <div class="m-foot">
      ${isNew ? '<button type="button" class="btn ghost" data-browse-again>← Pick another folder</button>' : `<button type="button" class="btn ghost danger" data-remove-project="${esc(oldId)}">Remove project</button>`}
      <div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" id="cfgSave">${isNew ? 'Add project' : 'Save'}</button></div>
    </div>
  </form>`;
  if (!dlg.open) dlg.showModal();
  const form = $('#cfgForm');
  // Fill the board picker from monday.com (when a token is set).
  api('/api/monday/boards').then(b => {
    const sel = $('#mondayBoard');
    const hint = $('#mondayBoardHint');
    if (!sel) return;
    const cur = (p.monday || {}).boardId || '';
    if (!b.connected) { hint.innerHTML = 'Add a monday.com token in Settings → Integrations to pick a board.'; return; }
    if (b.error) { hint.textContent = b.error; return; }
    const opts = [['', 'None'], ...b.boards.map(x => [x.id, `${x.name}${x.workspace ? ` · ${x.workspace}` : ''}`])];
    if (cur && !b.boards.some(x => x.id === cur)) opts.push([cur, `Board ${cur} (not visible to this token)`]);
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    hint.textContent = `${b.boards.length} board(s) visible to your token.`;
  }).catch(() => { const h = $('#mondayBoardHint'); if (h) h.textContent = 'Could not load boards.'; });
  dlg.onclick = async e => {
    if (e.target.closest('[data-browse-again]')) return browseFolder(dlg, '');
    if (e.target.closest('[data-q-suggest]')) return suggestQuality(form, oldId);
    const rm = e.target.closest('[data-remove-project]');
    if (!rm) return;
    if (!confirm(`Remove "${p.name}" from Dev Crew?\nOnly the config entry goes: its folder, repos, branches and task history stay.`)) return;
    try {
      await api(`/api/projects/${encodeURIComponent(rm.dataset.removeProject)}`, { method: 'DELETE' });
      toast(`${p.name} removed`);
      dlg.close();
      location.hash = '#/today';
    } catch (err) { toast(err.message, true); }
  };
  form.addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const F = form.elements;
    const activeRoles = [...form.querySelectorAll('input[name=active]:checked')].map(i => i.value);
    if (!activeRoles.length) return toast('Keep at least one role', true);
    const roles = {};
    for (const r of S.roles) roles[r.id] = { repo: F[`repo_${r.id}`].value, model: F[`model_${r.id}`].value, notes: F[`notes_${r.id}`].value, limits: { ...(((p.roles || {})[r.id] || {}).limits || {}), taskBudgetUsd: F[`rlb_${r.id}`].value, taskTimeoutMin: F[`rlt_${r.id}`].value } };
    const body = {
      id: F.id.value.trim(), name: F.name.value, folder: F.folder.value, stack: F.stack.value, context: F.context.value,
      activeRoles, roles, handoffs: F.handoffs.value, knowledgeGraph: F.knowledgeGraph.value, allowCommands: F.allowCommands.value,
      mondayBoardId: F.mondayBoardId.value,
      quality: {
        commands: Object.fromEntries(Q_CHECKS.map(([k]) => [k, F[`q_${k}`].value])),
        rules: F.q_rules.value, requireTests: F.q_requireTests.checked, noNewWarnings: F.q_noNewWarnings.checked, verify: F.q_verify.checked,
      },
      limits: { ...(p.limits || {}), taskBudgetUsd: F.lim_budget.value, taskTimeoutMin: F.lim_time.value },
    };
    const btn = $('#cfgSave');
    btn.disabled = true;
    try {
      const r = await api(`/api/projects/${encodeURIComponent(oldId || '_new')}`, { method: 'PUT', body });
      toast(isNew ? `${body.name} added` : 'Saved');
      dlg.close();
      location.hash = `#/p/${r.id}`;
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- people editor ---------------- */

async function openPeople() {
  const dlg = $('#cfgDlg');
  let people;
  try { people = (await api('/api/people')).people; } catch (e) { return toast(e.message, true); }
  const row = (x = {}) => `<div class="person-row">
    <input name="name" placeholder="Name" value="${esc(x.name || '')}">
    <input name="title" placeholder="Title" value="${esc(x.title || '')}">
    <input name="company" placeholder="Company" value="${esc(x.company || '')}">
    <input name="email" placeholder="Email" value="${esc(x.email || '')}">
    <input name="teams" placeholder="Teams (email)" value="${esc(x.teams || '')}">
    <input name="hours" placeholder="Hours, e.g. Mon–Fri 9–17" value="${esc(x.hours || '')}">
    <input name="projects" placeholder="Projects (ids, or *)" value="${esc((x.projects || []).join(', '))}">
    <input name="roles" placeholder="Roles, e.g. backend, qa" value="${esc((x.roles || []).join(', '))}">
    <input name="skills" placeholder="Skills" value="${esc((x.skills || []).join(', '))}">
    <label class="check"><input type="checkbox" name="contractor" ${x.contractor ? 'checked' : ''}> Contractor</label>
    <button type="button" class="icon-btn" data-person-remove aria-label="Remove">✕</button>
  </div>`;
  dlg.innerHTML = `<form method="dialog" id="cfgForm">
    <div class="m-head"><h2>People</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <p class="hint">Staff and contractors behind each project and role. "Who should I ask?" and the agent cards use this list. Projects: ${S.projects.map(p => `<code>${esc(p.id)}</code>`).join(' ')}; roles: ${S.roles.map(r => `<code>${r.id}</code>`).join(' ')}.</p>
      <div id="peopleRows">${people.map(row).join('') || ''}</div>
      <button type="button" class="btn sm" data-person-add>+ Add person</button>
    </div>
    <div class="m-foot"><span></span><div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div></div>
  </form>`;
  if (!people.length) $('#peopleRows').insertAdjacentHTML('beforeend', row());
  dlg.showModal();
  dlg.onclick = e => {
    if (e.target.closest('[data-person-add]')) return $('#peopleRows').insertAdjacentHTML('beforeend', row());
    const rmv = e.target.closest('[data-person-remove]');
    if (rmv) rmv.closest('.person-row').remove();
  };
  $('#cfgForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const list = [...document.querySelectorAll('#peopleRows .person-row')].map(r => {
      const v = n => r.querySelector(`[name=${n}]`);
      return { name: v('name').value, title: v('title').value, company: v('company').value, email: v('email').value, teams: v('teams').value,
        hours: v('hours').value, projects: v('projects').value, roles: v('roles').value, skills: v('skills').value, contractor: v('contractor').checked };
    }).filter(x => x.name.trim());
    try {
      await api('/api/people', { method: 'PUT', body: { people: list } });
      toast(`Saved ${list.length} ${list.length === 1 ? 'person' : 'people'}`);
      dlg.close();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------------- housekeeping ---------------- */

const size = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);

async function openHousekeeping() {
  drawer = { kind: 'housekeeping', id: '' };
  const el = $('#drawer');
  el.innerHTML = `<div class="d-head" id="dHead"><div class="line1"><b>Housekeeping</b><span class="grow"></span><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <h2>Clean up what is no longer needed</h2></div>
    <div class="d-body"><div id="dInfo"><p class="hint">Checking worktrees and branches…</p></div></div>
    <div class="d-foot" id="dFoot"></div>`;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('show');
  try {
    renderHousekeeping(await api('/api/housekeeping'));
  } catch (e) {
    $('#dInfo').innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
  }
}

function renderHousekeeping(h) {
  if (!drawer || drawer.kind !== 'housekeeping') return;
  const p = h.plan;
  const s = h.settings;
  const list = (title, items, fmt) => items.length ? `<div class="d-section"><h4>${title} <span class="faint">(${items.length})</span></h4><ul class="hk-list">${items.map(i => `<li>${fmt(i)}</li>`).join('')}</ul></div>` : '';
  const last = h.last
    ? `<p class="hint">Last cleanup ${ago(h.last.at)} (${esc(h.last.trigger)}): ${[
      h.last.done.worktrees + h.last.done.orphanDirs ? `${h.last.done.worktrees + h.last.done.orphanDirs} worktree(s)` : '',
      h.last.done.branches ? `${h.last.done.branches} branch(es)` : '',
      h.last.done.tasks ? `${h.last.done.tasks} task(s) archived` : '',
      h.last.done.bytes ? `${size(h.last.done.bytes)} freed` : '',
    ].filter(Boolean).join(', ') || 'nothing to do'}${h.last.skipped.length ? `; skipped ${h.last.skipped.length}` : ''}.</p>` : '';
  $('#dInfo').innerHTML = `
    <div class="hk-summary ${h.empty ? '' : 'has'}"><b>${esc(h.summary)}</b></div>
    <p class="hint">Rules: a finished task's worktree goes after ${s.worktreeDays} day(s), or once its branch is merged; its branch stays unless every commit is already merged. Tasks older than ${s.taskDays} day(s) move to <code>data/archive</code>. Nothing a queued task builds on, and no worktree with uncommitted changes, is ever touched.</p>
    ${list('Worktrees to remove', p.worktrees, w => `${esc(w.title)} <span class="faint">· ${esc(w.reason)} · ${size(w.sizeBytes)}</span><div class="faint mono">${esc(w.branch || '')}</div>`)}
    ${list('Leftover worktree folders', p.orphanDirs, d => `<span class="mono">${esc(d.path)}</span> <span class="faint">· ${size(d.sizeBytes)}</span>`)}
    ${list('Merged branches to delete', p.branches, b => `<span class="mono">${esc(b.name)}</span> <span class="faint">· ${esc(b.repo)} · ${esc(b.reason)}</span>`)}
    ${list('Tasks and stand-ups to archive', [...p.tasks.map(id => (S.tasks.find(t => t.id === id) || { title: id }).title), ...p.reports.map(() => 'Stand-up')], x => esc(x))}
    ${list('Kept', p.keep, k => `${k.kind === 'branch' ? `<span class="mono">${esc(k.name)}</span>` : esc(k.name)} <span class="faint">· ${esc(k.reason)}</span>`)}
    <div class="d-section"><h4>Schedule</h4><p class="hint">${s.auto ? 'Runs by itself once a week.' : 'Runs only when you press Clean up.'} Change it in <code>settings.housekeeping</code> (<code>worktreeDays</code>, <code>taskDays</code>, <code>auto</code>).</p>${last}</div>`;
  $('#dFoot').innerHTML = `<div class="acts"><button class="btn" data-hk="refresh">Check again</button>
    <button class="btn primary" data-hk="run" ${h.empty ? 'disabled' : ''}>Clean up</button></div>`;
}

async function housekeepingAction(act) {
  try {
    if (act === 'refresh') return renderHousekeeping(await api('/api/housekeeping'));
    if (!confirm('Clean up now? Worktree folders are deleted (branches with unmerged work are kept) and old tasks are archived.')) return;
    $('#dFoot').innerHTML = '<div class="acts"><span class="hint">Cleaning up…</span></div>';
    const r = await api('/api/housekeeping/run', { method: 'POST' });
    toast(`Done: ${r.planned}${r.skipped.length ? ` (skipped ${r.skipped.length})` : ''}`);
    renderHousekeeping(await api('/api/housekeeping'));
  } catch (e) {
    toast(e.message, true);
  }
}

function refreshDrawer(first) {
  if (!drawer) return;
  if (drawer.kind === 'housekeeping') return; // rendered on open and after each action
  if (drawer.kind === 'report') return refreshReportDrawer();
  const t = S.tasks.find(x => x.id === drawer.id);
  if (!t) return closeDrawer();
  const p = projOf(t.projectId);
  const r = roleOf(t.role);
  const repo = p && p.repos.find(x => x.name === t.repo);
  $('#dHead').innerHTML = `<div class="line1">${roleChip(t.role)} <span style="color:var(--muted);font-size:12.5px">${esc(r.name)} · ${esc(p ? p.name : t.projectId)}</span><span class="grow"></span>${statusPill(t)}<button class="icon-btn" data-close aria-label="Close">✕</button></div><h2 id="dTitle">${esc(t.title)}</h2>`;

  const g = t.git;
  const cmds = repo && t.branch ? [
    ['See the commits', `git -C "${repo.path}" log --oneline ${(t.baseSha || '').slice(0, 10)}..${t.branch}`],
    ['See the diff', `git -C "${repo.path}" diff ${(t.baseSha || '').slice(0, 10)}...${t.branch}`],
    ['When you are happy, push it yourself', `git -C "${repo.path}" push -u origin ${t.branch}`],
  ] : [];
  // Live updates rebuild the drawer: keep what the owner is typing into the review form.
  const keepPr = $('#revPr') ? $('#revPr').value : null;
  const keepEvent = $('#revEvent') ? $('#revEvent').value : null;
  const prFocused = document.activeElement && document.activeElement.id === 'revPr';
  $('#dInfo').innerHTML = `
    <dl class="kv">
      <dt>Mode</dt><dd>${t.mode === 'change' ? 'Changes code on its own branch' : 'Read-only investigation'}</dd>
      <dt>Repo</dt><dd>${esc(t.repo === '*' ? 'whole project' : t.repo)}${repo ? ` <span style="color:var(--faint)">${esc(repo.path)}</span>` : ''}</dd>
      ${t.branch ? `<dt>Branch</dt><dd><code>${esc(t.branch)}</code> from <code>${esc(t.base)}</code></dd>` : t.base ? `<dt>Base</dt><dd><code>${esc(t.base)}</code></dd>` : ''}
      ${t.worktree ? `<dt>Worktree</dt><dd>${t.cleaned ? '<i>removed (branch kept)</i>' : `<code>${esc(t.worktree)}</code>`}</dd>` : ''}
      <dt>Assigned</dt><dd>${fmtTime(t.createdAt)}${t.endedAt ? ` · finished ${ago(t.endedAt)}` : ''}</dd>
      ${t.turns ? `<dt>Usage</dt><dd>${t.turns} turns${t.costUsd ? ' · ' + money(t.costUsd) : ''}${t.wallMs ? ' · ' + dur(t.wallMs) : ''}${t.model ? ' · ' + esc(t.model) : ''}${t.tokens ? ` · ${tokenWords(t.tokens)}` : ''}</dd>` : ''}
      ${t.estimate ? `<dt>Estimate</dt><dd>${estRange(t.estimate)} <span style="color:var(--faint)">${t.estimate.basis === 'default' ? '(rough)' : `(from ${t.estimate.samples} past runs)`}</span>${etaText(t) ? ' · ' + esc(etaText(t)) : ''}</dd>` : ''}
      ${t.appliedLimits || t.limits ? (() => { const l = t.appliedLimits || {}; const parts = [l.taskBudgetUsd ? `$${l.taskBudgetUsd} per run` : '', l.taskTimeoutMin ? `${l.taskTimeoutMin} min per run` : ''].filter(Boolean); return parts.length ? `<dt>Limits</dt><dd>${parts.join(' · ')}</dd>` : ''; })() : ''}
    </dl>
    ${t.details ? `<div class="d-section"><h4>Details</h4><div class="box md">${md(t.details)}</div></div>` : ''}
    ${t.error && t.status !== 'done' ? `<div class="d-section"><div class="err-box">${esc(t.error)}</div></div>` : ''}
    ${g ? `<div class="d-section"><h4>Branch</h4><div class="box">
        <div style="margin-bottom:6px">${g.commits.length} commit(s)${g.shortstat ? ' · ' + esc(g.shortstat) : ''}${g.uncommitted ? ` · <span style="color:var(--amber)">${g.uncommitted} uncommitted file(s) in the worktree</span>` : ''}</div>
        ${g.commits.length ? `<div class="commits">${esc(g.commits.join('\n'))}</div>` : ''}
        ${g.files ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">Files</summary><div class="commits">${esc(g.files)}</div></details>` : ''}
      </div>${cmds.map(([label, c]) => `<div style="font-size:12px;color:var(--faint);margin-top:8px">${label}</div><div class="cmd"><span>${esc(c)}</span><button class="btn sm ghost" data-copy="${esc(c)}">Copy</button></div>`).join('')}</div>` : ''}
    ${checksHtml(t)}${noChangesHtml(t)}${refusedHtml(t)}${reviewHtml(t)}${mergeHtml(t, repo)}${reviewAsk(t)}
    ${handoffsHtml(t)}${planHtml(t)}${chainHtml(t)}
    ${t.result ? `<div class="d-section"><h4>Report</h4>${md(t.review && t.review.result ? t.result.replace(/\n##\s*Review\s*\n[\s\S]*$/i, '') : t.result)}</div>` : ''}
    ${(t.history || []).length > 1 ? `<div class="d-section"><h4>Earlier turns</h4>${t.history.slice(0, -1).map(h => `<details class="box" style="margin-bottom:6px"><summary style="cursor:pointer">${esc(h.prompt.slice(0, 120))} · ${ago(h.at)}</summary>${md(h.result)}</details>`).join('')}</div>` : ''}`;

  if (keepPr !== null && $('#revPr')) { $('#revPr').value = keepPr; if (prFocused) $('#revPr').focus(); }
  if (keepEvent !== null && $('#revEvent')) $('#revEvent').value = keepEvent;
  const active = t.status === 'running' || t.status === 'queued';
  const canFollow = !active && !t.cleaned;
  const foot = $('#dFoot');
  const draft = foot.querySelector('textarea') ? foot.querySelector('textarea').value : '';
  // After a limit stopped the run, offer to resume the same session with raised limits. The one
  // that was hit is suggested at double; the other keeps its value.
  const al = t.appliedLimits || {};
  const keepBudget = foot.querySelector('#contBudget') ? foot.querySelector('#contBudget').value : '';
  const keepTime = foot.querySelector('#contTime') ? foot.querySelector('#contTime').value : '';
  const contRow = canFollow && t.status === 'stopped' ? `
    <div class="continue-limits">
      <span>Continue picks up where it stopped: same session, same branch, nothing redone. Limits for the next run:</span>
      <label>$ <input type="number" id="contBudget" min="0" step="0.5" value="${esc(keepBudget || (t.stopReason === 'budget' ? (al.taskBudgetUsd || 2) * 2 : al.taskBudgetUsd ?? ''))}"></label>
      <label><input type="number" id="contTime" min="0" step="5" value="${esc(keepTime || (t.stopReason === 'timeout' ? (al.taskTimeoutMin || 30) * 2 : al.taskTimeoutMin ?? ''))}"> min</label>
    </div>` : '';
  foot.innerHTML = `
    ${contRow}
    ${canFollow ? `<textarea id="followText" rows="2" placeholder="Follow up with the ${esc(r.name)}: ask a question, request changes, or say “continue”…"></textarea>` : ''}
    <div class="acts">
      <div class="card-actions">
        ${active ? '<button class="btn danger" data-task-act="cancel">Cancel</button>' : ''}
        ${!active && t.worktree && !t.cleaned ? '<button class="btn" data-task-act="cleanup" title="Delete the worktree folder; the branch stays in the repo">Remove worktree</button>' : ''}
        ${!active ? '<button class="btn ghost danger" data-task-act="delete">Delete</button>' : ''}
      </div>
      ${canFollow && t.status === 'stopped' ? '<button class="btn" data-task-act="continue" title="Resume the same session with a new allowance">Continue</button>' : ''}
      ${canFollow ? '<button class="btn primary" data-task-act="followup">Send follow-up</button>' : ''}
    </div>`;
  const ta = foot.querySelector('textarea');
  if (ta) {
    ta.value = draft;
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) taskAction('followup'); });
  }
  if (first && ta && t.status !== 'failed') ta.blur();
}

/* ---------------- refused commands and empty runs (task drawer) ---------------- */

/** Commands the agent was refused, each with a one-click "allow for this project". */
function refusedHtml(t) {
  const list = t.refused || [];
  if (!list.length) return '';
  const p = projOf(t.projectId);
  const allowed = (p && p.allowCommands) || [];
  const isAllowed = r => r.rule && allowed.includes(r.rule);
  const rows = list.map(r => `<li>
      <code class="cmdline">${esc(r.command)}</code>
      <div class="refused-act">${isAllowed(r) ? `<span class="ok-text">Allowed now: <code>${esc(r.rule)}</code></span>`
        : r.problem ? `<span class="faint">${esc(r.problem)}</span>`
          : `<button class="btn sm" data-allow-rule="${esc(r.rule)}">Allow <code>${esc(r.rule)}</code> for ${esc(p ? p.name : 'this project')}</button>`}</div>
    </li>`).join('');
  const anyAllowed = list.some(isAllowed);
  const canContinue = anyAllowed && !['running', 'queued'].includes(t.status) && !t.cleaned;
  return `<div class="d-section refused"><h4>Commands refused <span class="faint">(${list.length})</span></h4>
    <p class="hint">The agent tried these and the crew's permissions refused them, so some checks may not have run.${t.mode === 'analyze' ? ' Allowing a command applies to tasks that make changes; read-only tasks stay read-only.' : ''}</p>
    <ul class="refused-list">${rows}</ul>
    ${canContinue ? '<button class="btn sm primary" data-continue-allowed>Continue with the new permissions</button>' : ''}</div>`;
}

/** A change task that finished without changing anything: say so plainly. */
function noChangesHtml(t) {
  if (!t.noChanges || t.status !== 'done') return '';
  return `<div class="d-section"><div class="notice"><b>No changes made.</b> This task finished without a single commit, so there is nothing to review. Read the report for why, then send a follow-up or assign it again.</div></div>`;
}

/* ---------------- Code Reviewer and Conflict Fixer (task drawer) ---------------- */

const VERDICTS = { approve: ['Looks good', 'ok'], comment: ['Comments', 'info'], request_changes: ['Changes requested', 'bad'] };
const SEV_ICON = { critical: '⛔', major: '▲', minor: '●', nit: '·' };

/** The project's checks, run by Dev Crew on this task's branch. */
function checksHtml(t) {
  if (t.checking) return '<div class="d-section"><h4>Checks</h4><p class="hint">Dev Crew is running the project\'s checks on this branch…</p></div>';
  const c = t.checks || [];
  if (!c.length) return '';
  const bad = c.filter(x => !x.ok && !x.skipped).length;
  return `<div class="d-section"><h4>Checks ${bad ? `<span class="verdict bad">${bad} failed</span>` : '<span class="verdict ok">passed</span>'}</h4>
    <ul class="checks">${c.map(x => `<li class="${x.ok ? 'ok' : x.skipped ? 'skip' : 'bad'}"><div><span class="chk">${x.ok ? '✓' : x.skipped ? '–' : '✕'}</span> <b>${esc(x.label)}</b> <code>${esc(x.cmd)}</code> <span class="faint">${x.skipped ? 'skipped' : x.ms ? dur(x.ms) : ''}</span></div>${x.tail ? `<details ${x.ok || x.skipped ? '' : 'open'}><summary>Output</summary><pre class="commits">${esc(x.tail)}</pre></details>` : ''}</li>`).join('')}</ul>
    <p class="hint">${bad && t.status === 'done' ? 'Send a follow-up asking for a fix; Dev Crew runs the checks again after it. ' : ''}Ran ${t.checksAt ? ago(t.checksAt) : ''} in the task's worktree.</p></div>`;
}

function reviewHtml(t) {
  const rv = t.review;
  if (!rv) return '';
  const head = `<p class="hint">Branch <code>${esc(rv.branch)}</code> against <code>${esc(rv.base || '?')}</code>${rv.prNumber ? ` · pull request #${esc(rv.prNumber)}` : ''}</p>`;
  if (!rv.result) return `<div class="d-section"><h4>Review</h4>${head}${t.status === 'done' ? '<p class="hint">No structured review came back; see the report.</p>' : ''}</div>`;
  const r = rv.result;
  const [vtext, vcls] = VERDICTS[r.verdict] || VERDICTS.comment;
  const counts = {};
  for (const f of r.findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const countText = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no findings';
  const rows = r.findings.map(f => `<li class="finding sev-${f.severity}">
      <div class="f-top"><span class="sev" title="${f.severity}">${SEV_ICON[f.severity] || '●'} ${f.severity}</span> <b>${esc(f.title)}</b>${f.file ? ` <code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code>` : ''}</div>
      ${f.detail ? `<div>${esc(f.detail)}</div>` : ''}
      ${f.suggestion ? `<div class="faint"><i>Suggestion:</i> ${esc(f.suggestion)}</div>` : ''}
    </li>`).join('');
  const posted = rv.posted
    ? `<p class="hint">Posted on pull request #${esc(rv.prNumber)} ${ago(rv.posted.at)}${rv.posted.url ? ` · <a href="${esc(rv.posted.url)}" target="_blank" rel="noopener">open</a>` : ''}.</p>`
    : '';
  const post = `<div class="review-post">
      <label>PR # <input type="text" id="revPr" inputmode="numeric" value="${esc(rv.prNumber || '')}" placeholder="123"></label>
      <select id="revEvent"><option value="comment">As a comment</option><option value="request_changes" ${r.verdict === 'request_changes' ? '' : ''}>Request changes</option><option value="approve">Approve</option></select>
      <button class="btn sm primary" data-review-post>${rv.posted ? 'Post again' : 'Post on the pull request'}</button>
    </div><p class="hint">Uses the GitHub CLI (<code>gh</code>) with your own login. GitHub does not let you approve or request changes on your own pull request; post those as a comment.</p>`;
  return `<div class="d-section"><h4>Review <span class="verdict ${vcls}">${vtext}</span></h4>${head}
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
    <p class="faint">${countText}</p>
    ${checklistHtml(r.checklist)}
    ${rows ? `<ul class="findings">${rows}</ul>` : ''}
    ${posted}${t.status === 'done' ? post : ''}</div>`;
}

function checklistHtml(list) {
  if (!(list || []).length) return '';
  const n = st => list.filter(c => c.status === st).length;
  return `<details class="checklist" ${n('fail') ? 'open' : ''}><summary>Checklist: ${n('pass')} passed · ${n('fail')} failed · ${n('n/a')} not applicable</summary>
    <ul class="checks">${list.map(c => `<li class="${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : 'skip'}"><div><span class="chk">${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}</span> ${esc(c.item)}</div>${c.note ? `<div class="faint">${esc(c.note)}</div>` : ''}</li>`).join('')}</ul></details>`;
}

function mergeHtml(t, repo) {
  if (!t.mergeTarget) return '';
  const st = t.merge && t.merge.state;
  const into = (t.mergeTargets || []).length > 1 ? t.mergeTargets.map(b => `<code>${esc(b)}</code>`).join(', ') : `<code>${esc(t.mergeTarget)}</code>`;
  const text = st === 'merged' ? `<b class="ok-text">Merged.</b> <code>${esc(t.branch)}</code> is <code>${esc(t.base)}</code> with ${into} merged in.`
    : st === 'unfinished' ? '<b class="warn">The merge is not finished.</b> Conflicts are still open in the worktree.'
      : st === 'not-merged' ? `<b class="warn">Not merged.</b> The Conflict Fixer stopped without merging; its report says why.`
        : `Merges ${into} into <code>${esc(t.base)}</code>.`;
  const local = String(t.base || '').replace(/^origin\//, '');
  const cmds = st === 'merged' && repo && t.branch ? [
    ['Update the pull request branch to the fixed one (it only adds commits)', `git -C "${repo.path}" push origin ${t.branch}:${local}`],
  ] : [];
  return `<div class="d-section"><h4>Conflicts</h4><p>${text}</p>${cmds.map(([label, c]) => `<div style="font-size:12px;color:var(--faint);margin-top:8px">${label}</div><div class="cmd"><span>${esc(c)}</span><button class="btn sm ghost" data-copy="${esc(c)}">Copy</button></div>`).join('')}</div>`;
}

/** "Ask for a review" under a finished change task, when the project has a Code Reviewer. */
function reviewAsk(t) {
  if (t.mode !== 'change' || !t.branch || t.status !== 'done' || roleOf(t.role).kind) return '';
  const rev = crewRoles(projOf(t.projectId)).find(r => r.kind === 'review');
  if (!rev) return '';
  return `<div class="d-section"><button class="btn sm" data-review-branch="${esc(t.id)}">Ask the ${esc(rev.name)} to review this branch</button></div>`;
}

/* ---------------- handoffs, plans and chains (task drawer) ---------------- */

const modeWord = m => (m === 'analyze' ? 'investigate' : 'make changes');

function handoffsHtml(t) {
  const list = t.handoffs || [];
  if (!list.length) return '';
  const card = h => {
    const child = h.taskId && taskOf(h.taskId);
    const state = h.status === 'proposed'
      ? `<div class="card-actions"><button class="btn sm primary" data-handoff="${h.id}" data-do="start">Start</button><button class="btn sm ghost" data-handoff="${h.id}" data-do="dismiss">Dismiss</button></div>`
      : h.status === 'started' && child ? `<button class="btn sm ghost" data-task="${child.id}">Open task ${statusPill(child)}</button>`
        : h.status === 'failed' ? `<span class="err-inline">${esc(h.error || 'Could not start')}</span> <button class="btn sm" data-handoff="${h.id}" data-do="start">Retry</button>`
          : `<span class="faint">${esc(h.status)}</span>`;
    return `<div class="handoff">
      <div class="handoff-top">${roleChip(h.role)} <b>${esc(h.title)}</b> <span class="faint">· ${modeWord(h.mode)}</span></div>
      ${h.reason ? `<div class="faint">${esc(h.reason)}</div>` : ''}
      ${h.details ? `<details><summary>Details</summary><div class="md">${md(h.details)}</div></details>` : ''}
      <div class="handoff-act">${state}</div>
    </div>`;
  };
  const policy = (projOf(t.projectId) || {}).handoffs || 'ask';
  return `<div class="d-section"><h4>Handoff ${policy === 'auto' ? '<span class="faint">(started automatically)</span>' : ''}</h4>
    <p class="hint">The ${esc(roleOf(t.role).name)} says another role should act next.${t.mode === 'change' && t.branch ? ` A change task builds on <code>${esc(t.branch)}</code>; an investigation reads its worktree.` : ''}</p>
    ${list.map(card).join('')}</div>`;
}

function planHtml(t) {
  if (!t.plan) return '';
  const steps = t.plan.steps;
  const ids = t.plan.taskIds || [];
  const p = projOf(t.projectId);
  const names = p ? p.repos.map(r => r.name) : [];
  const missing = s => s.missingRepo || (s.repo && s.repo !== '*' && names.length && !names.includes(s.repo));
  // steps with the same number run at the same time
  const wave = {};
  for (const s of steps) wave[s.key] = missing(s) ? 0 : Math.max(0, ...s.dependsOn.map(k => wave[k] || 0)) + 1;
  const wide = Math.max(0, ...Object.values(wave).map(w => Object.values(wave).filter(x => x === w && w > 0).length));
  const row = (s, i) => {
    const task = ids[i] && taskOf(ids[i]);
    const gone = missing(s);
    // a plan started before this check existed may have run such a step in another repo
    const warn = !gone ? ''
      : task ? `This step's repo, <code>${esc(s.repo)}</code>, isn't in ${esc(p ? p.name : 'this project')}, so it ran in <code>${esc(task.repo)}</code> instead. New plans skip steps like this.`
        : `Won't start: the <code>${esc(s.repo)}</code> repo isn't in ${esc(p ? p.name : 'this project')}. Clone it into the project folder to include it.`;
    return `<li class="${gone && !task ? 'step-missing' : ''}">${wave[s.key] ? `<span class="wave" title="Steps with the same number run at the same time">${wave[s.key]}</span> ` : ''}${roleChip(s.role)} <b>${esc(s.title)}</b>${s.integrate ? ` <span class="tag">merges ${(s.mergeIn || []).length + 1} parallel branches</span>` : ''} <span class="faint">· ${modeWord(s.mode)}${s.repo ? ' · ' + esc(s.repo) : ''}${s.dependsOn.length ? ' · after ' + s.dependsOn.map(k => esc(k)).join(', ') : ''}</span>
      ${task ? ` <button class="btn sm ghost" data-task="${task.id}">${statusPill(task)}</button>` : ''}
      ${warn ? `<div class="step-warn">${warn}</div>` : ''}
      <div class="faint step-key">${esc(s.key)}</div></li>`;
  };
  const runnable = steps.filter(s => !missing(s)).length;
  const skipped = steps.filter((s, i) => missing(s) && !ids[i]).length;
  const acts = t.plan.status === 'proposed'
    ? `<div class="card-actions"><button class="btn primary" data-plan="start" ${runnable ? '' : 'disabled'}>Start plan (${runnable} task${runnable === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped` : ''})</button><button class="btn ghost" data-plan="dismiss">Dismiss</button></div>`
    : `<p class="hint">Plan ${esc(t.plan.status)}${skipped ? `; ${skipped} step${skipped === 1 ? ' was' : 's were'} not started because the repo isn't in the project` : ''}.</p>`;
  const par = wide > 1 ? `<p class="hint">Up to ${wide} steps run at the same time (the numbers show which), each on its own branch${steps.some(s => s.integrate) ? '; the Conflict Fixer then merges the parallel branches, so you review one' : ''}.${wide > (S.settings.maxConcurrent || 1) ? ` Settings allows ${S.settings.maxConcurrent} agent(s) at a time, so some wait.` : ''}</p>` : '';
  return `<div class="d-section"><h4>Plan</h4>${par}<ol class="plan">${steps.map(row).join('')}</ol>${acts}</div>`;
}

function chainHtml(t) {
  const parent = t.parentId && taskOf(t.parentId);
  const kids = childrenOf(t).filter(c => !(t.plan && (t.plan.taskIds || []).includes(c.id)) && !(t.handoffs || []).some(h => h.taskId === c.id));
  const deps = (t.dependsOn || []).filter(id => id !== t.parentId).map(taskOf).filter(Boolean);
  if (!parent && !kids.length && !deps.length) return '';
  const line = (label, x) => `<div class="chain-row"><span class="faint">${label}</span> ${roleChip(x.role)} <button class="linkish" data-task="${x.id}">${esc(x.title)}</button> ${statusPill(x)}</div>`;
  return `<div class="d-section"><h4>Chain</h4>
    ${parent ? line(t.origin === 'plan' ? 'Plan' : 'From', parent) : ''}
    ${deps.map(d => line('After', d)).join('')}
    ${kids.map(k => line('Next', k)).join('')}</div>`;
}

function refreshReportDrawer() {
  const r = S.reports.find(x => x.id === drawer.id);
  if (!r) return closeDrawer();
  const p = projOf(r.projectId);
  $('#dHead').innerHTML = `<div class="line1"><span style="color:var(--muted);font-size:12.5px">Stand-up · ${esc(p ? p.name : r.projectId)}</span><span class="grow"></span><span class="pill ${r.status === 'failed' ? 'red' : 'blue'}">${esc(r.status)}</span><button class="icon-btn" data-close aria-label="Close">✕</button></div><h2 id="dTitle">${esc(r.date)}</h2>`;
  $('#dInfo').innerHTML = r.error ? `<div class="err-box">${esc(r.error)}</div>` : r.status === 'done' ? '<p>Done. It is on the Stand-ups tab.</p>' : '';
  $('#dFoot').innerHTML = r.status === 'running' || r.status === 'queued' ? '<div class="acts"><button class="btn danger" data-report-cancel>Cancel</button></div>' : '';
}

async function taskAction(act) {
  const id = drawer && drawer.id;
  if (!id) return;
  try {
    if (act === 'followup') {
      const text = ($('#followText') || {}).value || '';
      if (!text.trim()) return toast('Write the follow-up first', true);
      await api(`/api/tasks/${id}/followup`, { method: 'POST', body: { text } });
      $('#followText').value = '';
      toast('Sent — the agent picks it up next');
    } else if (act === 'continue') {
      const extra = (($('#followText') || {}).value || '').trim();
      await api(`/api/tasks/${id}/followup`, { method: 'POST', body: {
        text: `Continue where you stopped: the last run hit a limit. Do not start over; pick up from your last step, finish the task and give the usual report.${extra ? `\n\nAlso from the owner: ${extra}` : ''}`,
        budgetUsd: ($('#contBudget') || {}).value,
        timeoutMin: ($('#contTime') || {}).value,
      } });
      if ($('#followText')) $('#followText').value = '';
      toast('Continuing from where it stopped');
    } else if (act === 'cancel') {
      await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    } else if (act === 'cleanup') {
      await api(`/api/tasks/${id}/cleanup`, { method: 'POST' });
      toast('Worktree removed; the branch is still in the repo');
    } else if (act === 'delete') {
      const t = S.tasks.find(x => x.id === id);
      if (!confirm(`Delete "${t.title}"?${t.worktree && !t.cleaned ? '\nIts worktree folder is removed too; the branch stays in the repo.' : ''}`)) return;
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      closeDrawer();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- assign dialog ---------------- */

function openAssign(pre = {}) {
  const dlg = $('#assignDlg');
  const r0 = route();
  const projectId = pre.projectId || (r0.view === 'project' ? r0.id : (S.projects[0] || {}).id);
  const crew0 = crewRoles(projOf(projectId));
  const role = pre.role && crew0.some(r => r.id === pre.role) ? pre.role : (crew0.find(r => r.id === 'backend') || crew0[0] || { id: 'backend' }).id;
  const mode = pre.mode || roleOf(role).defaultMode || 'change';
  const rolePick = (pid, sel) => crewRoles(projOf(pid)).map(r => `<label style="--rc:${r.color}"><input type="radio" name="role" value="${r.id}" ${r.id === sel ? 'checked' : ''}><span class="sw"></span>${esc(r.name)}</label>`).join('');
  dlg.innerHTML = `<form method="dialog" id="assignForm">
    <div class="m-head"><h2>Assign a task</h2><button class="icon-btn" value="cancel" formnovalidate aria-label="Close">✕</button></div>
    <div class="m-body">
      <div class="field"><label>Project</label>
        <select name="projectId">${S.projects.map(p => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <label class="check plan-first"><input type="checkbox" name="plan"> <span><b>Plan it first</b> · the Solutions Architect breaks this feature into linked tasks for the crew. You review the plan, then start it.</span></label>
      <div class="field not-planning"><label>Who</label>
        <div class="role-pick" id="rolePick">${rolePick(projectId, role)}</div></div>
      <div class="field not-planning mode-field"><label>Kind of task</label>
        <div class="mode-pick">
          <label><input type="radio" name="mode" value="change" ${mode === 'change' ? 'checked' : ''}><b>Make changes</b><span>Works on its own new branch and commits. Never pushes.</span></label>
          <label><input type="radio" name="mode" value="analyze" ${mode === 'analyze' ? 'checked' : ''}><b>Investigate &amp; report</b><span>Read-only: review, plan, audit, explain.</span></label>
        </div></div>
      <div class="grid2">
        <div class="field"><label>Repo</label><select name="repo"></select></div>
        <div class="field" id="baseField"><label>Start from branch</label><select name="base"></select></div>
      </div>
      <datalist id="branchList"></datalist>
      <div class="kind-fields kind-review">
        <p class="hint">The Code Reviewer reads the branch's changes against its base and lists findings by file and line. It never changes code. You can post the review on the pull request afterwards.</p>
        <div class="grid3">
          <div class="field"><label>Branch to review</label><input type="text" name="reviewBranch" list="branchList" autocomplete="off" spellcheck="false" placeholder="feature/login or origin/feature/login" value="${esc(pre.reviewBranch || '')}"></div>
          <div class="field"><label>Compare with</label><input type="text" name="reviewBase" list="branchList" autocomplete="off" spellcheck="false" placeholder="main" value="${esc(pre.reviewBase || '')}"></div>
          <div class="field"><label>Pull request <span style="font-weight:400;color:var(--faint)">(optional)</span></label><input type="text" name="prNumber" inputmode="numeric" placeholder="#123"></div>
        </div>
      </div>
      <div class="kind-fields kind-conflicts">
        <p class="hint">The Conflict Fixer makes its own branch from the branch you pick, merges the other branch into it and resolves the conflicts, then builds and tests. Your branch is not touched: you move the pull request to the fixed branch yourself.</p>
        <div class="grid2">
          <div class="field"><label>Branch to fix (the PR branch)</label><input type="text" name="fixBranch" list="branchList" autocomplete="off" spellcheck="false" placeholder="feature/login"></div>
          <div class="field"><label>Merge in</label><input type="text" name="mergeTarget" list="branchList" autocomplete="off" spellcheck="false" placeholder="origin/main"></div>
        </div>
      </div>
      ${pre.ticketId ? `<div class="linked">Linked to the monday.com ticket <b>${esc(pre.ticketName || '')}</b>. The agent reads the ticket and its latest updates.<input type="hidden" name="ticketId" value="${esc(pre.ticketId)}"></div>` : ''}
      <div class="field"><label>Task</label><input type="text" name="title" maxlength="200" required placeholder="e.g. Add pagination to GET /invoices" value="${esc(pre.title || '')}"></div>
      <div class="field"><label>Details <span style="font-weight:400;color:var(--faint)">(optional)</span></label>
        <textarea name="details" rows="4" placeholder="Acceptance criteria, ticket text, links, constraints…">${esc(pre.details || '')}</textarea></div>
      <div class="field"><label>Model</label>
        <select name="model"><option value="">Default (${esc(S.settings.model)})</option><option value="sonnet">Sonnet</option><option value="opus">Opus — hardest tasks</option><option value="haiku">Haiku — quick, cheap</option></select></div>
      <div class="estimate">
        <div class="est-head"><button type="button" class="btn sm" id="estBtn">Estimate ETA</button><span class="faint" id="estHint">Type the task, then check how long it should take.</span></div>
        <div id="estBox" aria-live="polite"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Cost limit per run <span style="font-weight:400;color:var(--faint)">(USD, 0 = none)</span></label>
          <input type="number" name="budgetUsd" min="0" step="0.5" inputmode="decimal"></div>
        <div class="field"><label>Time limit per run <span style="font-weight:400;color:var(--faint)">(minutes, 0 = none)</span></label>
          <input type="number" name="timeoutMin" min="0" step="5" inputmode="numeric"></div>
      </div>
    </div>
    <div class="m-foot">
      <label class="check"><input type="checkbox" name="more"> Keep open to assign another</label>
      <div class="card-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" id="assignSubmit">Assign</button></div>
    </div>
  </form>`;
  const form = $('#assignForm');
  const F = form.elements;
  let modeTouched = !!pre.mode;
  // Code Reviewer and Conflict Fixer: their own fields, a fixed kind of task, one repo.
  const kindOf = () => (F.plan.checked ? '' : roleOf(F.role.value).kind || '');
  const applyKind = () => {
    const k = kindOf();
    form.classList.toggle('kind-is-review', k === 'review');
    form.classList.toggle('kind-is-conflicts', k === 'conflicts');
    if (k) form.querySelector(`input[name=mode][value=${k === 'review' ? 'analyze' : 'change'}]`).checked = true;
    F.title.required = !k;
    F.title.placeholder = k === 'review' ? 'Optional: "Review <branch>" when blank'
      : k === 'conflicts' ? 'Optional: "Merge … and fix the conflicts" when blank'
      : F.plan.checked ? 'e.g. Let users export validation results to Excel' : 'e.g. Add pagination to GET /invoices';
  };
  const fillRepos = () => {
    applyKind();
    const p = projOf(F.projectId.value);
    const roleRepo = (p.roles[F.role.value] || {}).repo;
    const want = pre.repo && pre.repo !== '*' ? pre.repo : roleRepo;
    const analyze = F.mode.value === 'analyze' && !kindOf();
    const opts = p.repos.map(r => `<option value="${esc(r.name)}" ${r.name === want ? 'selected' : ''}>${esc(r.name)}</option>`);
    if (analyze) opts.unshift(`<option value="*" ${pre.repo === '*' || !want ? 'selected' : ''}>Whole project (all repos)</option>`);
    F.repo.innerHTML = opts.join('') || '<option value="">No repos found</option>';
    $('#baseField').style.display = analyze || kindOf() ? 'none' : '';
    fillBranches();
  };
  const fillBranches = async () => {
    const p = projOf(F.projectId.value);
    const repo = F.repo.value;
    F.base.innerHTML = '<option value="">Current branch</option>';
    if (!repo || repo === '*') return;
    try {
      const b = await api(`/api/branches?project=${encodeURIComponent(p.id)}&repo=${encodeURIComponent(repo)}`);
      F.base.innerHTML = b.branches.filter(x => !x.startsWith('agent/')).map(x => `<option value="${esc(x)}" ${x === b.current ? 'selected' : ''}>${esc(x)}${x === b.current ? ' (checked out)' : ''}</option>`).join('')
        || '<option value="">Current branch</option>';
      // Reviews and merges also pick from the crew's own branches and the remote ones.
      $('#branchList').innerHTML = [...b.branches, ...(b.remote || [])].map(x => `<option value="${esc(x)}">`).join('');
      const main = ['origin/main', 'origin/master', 'main', 'master'].find(x => b.branches.includes(x) || (b.remote || []).includes(x)) || '';
      if (!F.reviewBase.value) F.reviewBase.placeholder = main || 'main';
      if (!F.mergeTarget.value) F.mergeTarget.placeholder = main || 'origin/main';
    } catch { /* keep the default */ }
  };
  // Default limits follow the project / role until the owner edits them. The estimate is on
  // demand: Estimate ETA sends the typed task, and the answer is marked stale once anything that
  // feeds it changes.
  let limitsTouched = false;
  let estSeq = 0;
  let lastEst = null;
  const fillLimits = async () => {
    if (limitsTouched) return;
    const q = new URLSearchParams({ project: F.projectId.value, role: F.role.value, mode: F.mode.value, model: F.model.value });
    try {
      const e = await api(`/api/estimate?${q}`);
      if (!limitsTouched) { F.budgetUsd.value = e.limits.taskBudgetUsd; F.timeoutMin.value = e.limits.taskTimeoutMin; }
    } catch { /* leave the fields blank: the server applies the defaults */ }
  };
  const markStale = () => {
    if (!lastEst) return;
    lastEst = null;
    $('#estBox').classList.add('stale');
    $('#estHint').textContent = 'The task changed since this estimate. Press Estimate ETA again.';
  };
  // Warn when a typical run of this kind would not fit inside the limits as set.
  const checkLimitFit = e => {
    const el = $('#estWarn');
    if (!el || !e) return;
    const budget = Number(F.budgetUsd.value) || 0;
    const mins = Number(F.timeoutMin.value) || 0;
    const warn = [];
    if (budget && e.estimate.costUsd.p75 > budget) warn.push(`may hit the $${budget} cost limit`);
    if (mins && e.estimate.wallMs.p75 > mins * 60000) warn.push(`may hit the ${mins}-minute time limit`);
    el.innerHTML = warn.length ? `<b class="warn">Runs like this ${warn.join(' and ')}. Raise the limit or pick a cheaper model.</b>` : '';
  };
  const SIZE_WORDS = { small: 'looks like a small task', large: 'looks like a larger task', xlarge: 'looks like a big task' };
  const runEstimate = async () => {
    if (!F.title.value.trim()) { F.title.focus(); return toast('Type the task first', true); }
    const seq = ++estSeq;
    const btn = $('#estBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const e = await api('/api/estimate', { method: 'POST', body: {
        projectId: F.projectId.value, role: F.role.value, mode: F.mode.value, model: F.model.value,
        title: F.title.value, details: F.details.value,
      } });
      if (seq !== estSeq) return;
      const est = e.estimate;
      const basis = est.basis === 'similar'
        ? `based on ${est.samples} similar past tasks`
        : est.basis === 'default'
          ? `rough: no past runs of this kind yet${SIZE_WORDS[est.size] ? `, and it ${SIZE_WORDS[est.size]}` : ''}`
          : `from ${est.samples} past ${est.basis === 'project-role' ? 'runs by this role on this project' : est.basis === 'role' ? 'runs by this role' : 'runs of this kind'}${SIZE_WORDS[est.size] ? `; it ${SIZE_WORDS[est.size]}` : ''}`;
      const when = e.spend.paused
        ? '<b class="warn">Waits: today\'s spend limit is reached</b>'
        : e.eta ? (e.eta.start - Date.now() < 60000 ? 'Starts now' : `Starts in ~${dur(e.eta.start - Date.now())}`) + ` · done by ~${new Date(e.eta.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
      const box = $('#estBox');
      box.classList.remove('stale');
      box.innerHTML = `<div><b>≈ ${estRange(est)}</b> · ${esc(e.model)}</div><div>${when}</div><div class="faint">${esc(basis)}</div><div id="estWarn"></div>`;
      $('#estHint').textContent = 'Approximate. Real runs vary.';
      lastEst = e;
      checkLimitFit(e);
    } catch (err) {
      if (seq === estSeq) $('#estBox').textContent = `No estimate: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Estimate ETA';
    }
  };
  $('#estBtn').addEventListener('click', runEstimate);
  // "Plan it first": the task goes to the Architect as a read-only planning task.
  F.plan.addEventListener('change', () => {
    const on = F.plan.checked;
    form.classList.toggle('planning', on);
    if (on) {
      const arch = form.querySelector('input[name=role][value=architect]');
      if (arch) arch.checked = true; // the server gives plans to the Architect either way
      form.querySelector('input[name=mode][value=analyze]').checked = true;
    }
    fillRepos();
    markStale();
    fillLimits();
  });
  F.title.addEventListener('input', markStale);
  F.details.addEventListener('input', markStale);
  F.budgetUsd.addEventListener('input', () => { limitsTouched = true; checkLimitFit(lastEst); });
  F.timeoutMin.addEventListener('input', () => { limitsTouched = true; checkLimitFit(lastEst); });
  F.model.addEventListener('change', () => { markStale(); fillLimits(); });
  F.projectId.addEventListener('change', () => {
    pre = {};
    // Only this project's roles; keep the chosen role when the new project has it.
    const keep = F.role.value;
    const crew = crewRoles(projOf(F.projectId.value));
    const sel = F.plan.checked ? 'architect' : crew.some(r => r.id === keep) ? keep : (crew[0] || {}).id;
    $('#rolePick').innerHTML = rolePick(F.projectId.value, sel);
    fillRepos(); markStale(); fillLimits();
  });
  F.repo.addEventListener('change', fillBranches);
  form.querySelectorAll('input[name=mode]').forEach(i => i.addEventListener('change', () => { modeTouched = true; fillRepos(); markStale(); fillLimits(); }));
  // Delegated: the role buttons are rebuilt when the project changes.
  form.addEventListener('change', e => {
    if (e.target.name !== 'role') return;
    if (!modeTouched) form.querySelector(`input[name=mode][value=${roleOf(F.role.value).defaultMode}]`).checked = true;
    fillRepos();
    markStale();
    fillLimits();
  });
  form.addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    // Blank "compare with" / "merge in" fields mean the suggested branch shown as the hint.
    if (kindOf() === 'review' && !body.reviewBase) body.reviewBase = F.reviewBase.placeholder === 'main' ? '' : F.reviewBase.placeholder;
    if (kindOf() === 'conflicts' && !body.mergeTarget) body.mergeTarget = F.mergeTarget.placeholder;
    const btn = $('#assignSubmit');
    btn.disabled = true;
    try {
      await api('/api/tasks', { method: 'POST', body });
      toast(`Assigned to ${roleOf(body.role).name}`);
      if (F.more.checked) { F.title.value = ''; F.details.value = ''; markStale(); F.title.focus(); }
      else dlg.close();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  fillRepos();
  fillLimits();
  dlg.showModal();
  F.title.focus();
}

/* ---------------- events ---------------- */

document.addEventListener('click', async e => {
  const ob = e.target.closest('[data-office]');
  if (ob && office && office.zoomBy) {
    const a = ob.dataset.office;
    if (a === 'in') office.zoomBy(1.25); else if (a === 'out') office.zoomBy(0.8); else office.fit();
    return;
  }
  const pe = e.target.closest('[data-card-close],[data-ticket-work],[data-ticket-post],[data-person],[data-person-assign],[data-pick]');
  if (pe) {
    const d = pe.dataset;
    if (d.cardClose !== undefined) return closeAgentCard();
    if (d.pick) return pickPerson(d.pick);
    if (d.person) { e.preventDefault(); return showPerson(d.person, d.project || (ui.card && ui.card.pid), d.role || (ui.card && ui.card.role)); }
    if (d.personAssign) { $('#peoplePop').hidden = true; return openPersonAssign(d.personAssign, d.project, d.role); }
    if (d.ticketWork && ui.card) {
      const it = (boardOf(ui.card.pid) || { items: [] }).items.find(i => i.id === d.ticketWork);
      if (it) openAssign({ projectId: ui.card.pid, role: ui.card.role, title: it.name, ticketId: it.id, ticketName: it.name });
      return;
    }
    if (d.ticketPost) {
      const t = S.tasks.find(x => x.id === d.ticketPost);
      const b = boardOf(t.projectId);
      if (!confirm(`Post the ${roleOf(t.role).name}'s report as an update on “${t.ticket.name}”${b && !b.demo ? ' on monday.com' : ' (demo board)'}?`)) return;
      try { await api(`/api/tasks/${t.id}/monday-update`, { method: 'POST' }); toast('Report posted to the ticket'); } catch (err) { toast(err.message, true); }
      return;
    }
  }
  if (e.target.closest('[data-housekeeping]')) { $('#sidebar').classList.remove('open'); return openHousekeeping(); }
  const ep = e.target.closest('[data-edit-project],[data-add-project],[data-people]');
  if (ep) {
    e.preventDefault();
    $('#sidebar').classList.remove('open');
    if (ep.dataset.people !== undefined) return openPeople();
    return openProjectEditor(ep.dataset.editProject || null);
  }
  const hk = e.target.closest('[data-hk]');
  if (hk) return housekeepingAction(hk.dataset.hk);
  const rb = e.target.closest('[data-review-branch]');
  if (rb) {
    const t = S.tasks.find(x => x.id === rb.dataset.reviewBranch);
    const rev = t && crewRoles(projOf(t.projectId)).find(r => r.kind === 'review');
    if (t && rev) openAssign({ projectId: t.projectId, role: rev.id, repo: t.repo, reviewBranch: t.branch, reviewBase: t.base });
    return;
  }
  if (e.target.id === 'graphUpdate') {
    const pid = $('#graphPage').dataset.pid;
    e.target.disabled = true;
    try { await api(`/api/projects/${encodeURIComponent(pid)}/graph/${encodeURIComponent(graphUi.repo)}/update`, { method: 'POST' }); toast('Updating the graph'); }
    catch (err) { toast(err.message, true); }
    loadGraph(pid);
    return;
  }
  const um = e.target.closest('[data-unclamp]');
  if (um) {
    const box = um.previousElementSibling;
    const open = box.classList.toggle('open');
    um.textContent = open ? 'Less' : 'More';
    return;
  }
  const ar = e.target.closest('[data-allow-rule]');
  if (ar && drawer) {
    const t = S.tasks.find(x => x.id === drawer.id);
    const rule = ar.dataset.allowRule;
    if (!t || !confirm(`Allow agents on ${(projOf(t.projectId) || {}).name || 'this project'} to run "${rule} …" from now on? You can remove it in Edit project → Extra allowed commands.`)) return;
    ar.disabled = true;
    try {
      const r = await api(`/api/projects/${t.projectId}/allow`, { method: 'POST', body: { rule } });
      const p = projOf(t.projectId);
      if (p) p.allowCommands = r.allowCommands;
      toast(`Allowed: ${rule}`);
      refreshDrawer();
    } catch (err) { toast(err.message, true); ar.disabled = false; }
    return;
  }
  if (e.target.closest('[data-continue-allowed]') && drawer) {
    const t = S.tasks.find(x => x.id === drawer.id);
    const p = t && projOf(t.projectId);
    const rules = (t.refused || []).filter(r => r.rule && ((p && p.allowCommands) || []).includes(r.rule)).map(r => r.rule);
    const text = `The owner has now allowed: ${rules.join(', ')}. Continue the task: run the commands that were refused before (one per call), then build and test, and update your report with the real results.`;
    try { await api(`/api/tasks/${t.id}/followup`, { method: 'POST', body: { text } }); toast('Continuing with the new permissions'); }
    catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.closest('[data-review-post]') && drawer) {
    const pr = ($('#revPr').value || '').trim().replace(/^#/, '');
    const ev = $('#revEvent').value;
    if (!/^\d+$/.test(pr)) { $('#revPr').focus(); return toast('Type the pull request number', true); }
    const what = { comment: 'as a comment', approve: 'as an approval', request_changes: 'as "request changes"' }[ev];
    if (!confirm(`Post this review on pull request #${pr} ${what}, from your GitHub account?`)) return;
    const btn = e.target.closest('[data-review-post]');
    btn.disabled = true;
    try { await api(`/api/tasks/${drawer.id}/review/post`, { method: 'POST', body: { prNumber: pr, event: ev } }); toast('Review posted'); }
    catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
    return;
  }
  // Handoff and plan buttons in the task drawer.
  const hb = e.target.closest('[data-handoff],[data-plan]');
  if (hb && drawer) {
    const d = hb.dataset;
    hb.disabled = true;
    try {
      if (d.handoff) {
        const r = await api(`/api/tasks/${drawer.id}/handoffs/${d.handoff}/${d.do}`, { method: 'POST' });
        toast(d.do === 'start' ? `Handed off to the ${roleOf(r.child.role).name}` : 'Handoff dismissed');
      } else {
        const r = await api(`/api/tasks/${drawer.id}/plan/${d.plan}`, { method: 'POST' });
        toast(d.plan === 'start' ? `Plan started: ${r.tasks.length} linked task(s)` : 'Plan dismissed');
      }
    } catch (err) {
      toast(err.message, true);
      hb.disabled = false;
    }
    return;
  }
  const el = e.target.closest('[data-act],[data-task],[data-report],[data-filter],[data-role-filter],[data-rolefilter],[data-close],[data-copy],[data-task-act],[data-report-cancel],[data-suggest],[data-suggest-all],#logBottom');
  if (!el) {
    if (e.target.closest('.nav-item')) $('#sidebar').classList.remove('open');
    return;
  }
  const d = el.dataset;
  if (d.task && !d.taskAct) { e.preventDefault(); return openDrawer('task', d.task); }
  if (d.report) return openDrawer('report', d.report);
  if (d.close !== undefined) return closeDrawer();
  if (d.copy) return copy(d.copy);
  if (d.taskAct) return taskAction(d.taskAct);
  if (el.id === 'logBottom') { const b = $('#dLog'); b.scrollTop = b.scrollHeight; return; }
  if (d.reportCancel !== undefined) return api(`/api/reports/${drawer.id}/cancel`, { method: 'POST' }).catch(err => toast(err.message, true));
  if (d.filter) { ui.taskFilter = d.filter; return render(); }
  if (d.roleFilter !== undefined) { ui.roleFilter = d.roleFilter; return render(); }
  if (d.rolefilter) { ui.roleFilter = d.rolefilter; ui.taskFilter = 'all'; return; }
  if (d.act === 'assign') return openAssign({ projectId: d.project, role: d.role });
  if (d.act === 'standup') {
    try {
      const made = await api('/api/reports/run', { method: 'POST', body: { projectId: d.project } });
      toast(made.length ? 'Stand-up queued' : 'A stand-up is already running');
      location.hash = `#/p/${d.project}/standups`;
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (d.suggest) {
    const [rid, j] = d.suggest.split(':');
    const r = S.reports.find(x => x.id === rid);
    const s = r.suggestions[+j];
    return openAssign({ projectId: r.projectId, ...s });
  }
  if (d.suggestAll) {
    const r = S.reports.find(x => x.id === d.suggestAll);
    if (!confirm(`Assign all ${r.suggestions.length} suggested tasks for ${projOf(r.projectId).name}?`)) return;
    let ok = 0;
    for (const s of r.suggestions) {
      try { await api('/api/tasks', { method: 'POST', body: { projectId: r.projectId, ...s } }); ok++; }
      catch (err) { toast(`${s.title}: ${err.message}`, true); }
    }
    if (ok) toast(`Assigned ${ok} task(s)`);
  }
});

$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('pointerdown', e => {
  const pop = $('#peoplePop');
  if (!pop.hidden && !e.target.closest('#peoplePop,#peopleQ,#assignDlg')) pop.hidden = true;
});
$('#peopleQ').addEventListener('input', e => { clearTimeout(searchTimer); const q = e.target.value; searchTimer = setTimeout(() => runSearch(q), 350); });
$('#peopleQ').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value); }
  if (e.key === 'Escape') { $('#peoplePop').hidden = true; e.target.blur(); }
});
$('#peopleQ').addEventListener('focus', () => { if (lastSearch && $('#peopleQ').value) $('#peoplePop').hidden = false; });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#peopleQ').focus(); $('#peopleQ').select(); }
});
document.addEventListener('change', async e => {
  const page = $('#graphPage');
  if (!page) return;
  if (e.target.id === 'graphRepo') { graphUi.repo = e.target.value; loadGraph(page.dataset.pid); }
  if (e.target.id === 'graphMode') {
    try { await api(`/api/projects/${encodeURIComponent(page.dataset.pid)}/graph-update`, { method: 'POST', body: { mode: e.target.value } }); toast(e.target.value === 'off' ? 'The graph updates only when you press Update' : e.target.value === 'commits' ? 'The graph updates after new commits' : 'The graph updates once a week'); }
    catch (err) { toast(err.message, true); }
  }
});
document.addEventListener('keydown', e => {
  const t = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && t instanceof HTMLElement && t.getAttribute('role') === 'button' && t.tagName !== 'BUTTON') {
    e.preventDefault();
    t.click();
  }
  if (e.key === 'Tab' && drawer && !document.querySelector('dialog[open]')) {
    const box = $('#drawer');
    const items = [...box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || $('#assignDlg').open) return;
  if (drawer) closeDrawer(); else if (ui.card) closeAgentCard();
});
$('#assignBtn').addEventListener('click', () => openAssign());
$('#skipLink').addEventListener('click', () => $('#main').focus());
// The side menu: on wide screens ☰ (or Ctrl+B) hides it for a full-width view and remembers
// that choice in this browser; on small screens it slides in over the page.
const NAV_KEY = 'devcrew.navCollapsed';
const narrow = () => matchMedia('(max-width: 860px)').matches;
function syncMenuBtn() {
  const open = narrow() ? $('#sidebar').classList.contains('open') : !document.body.classList.contains('nav-collapsed');
  const btn = $('#menuBtn');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Hide menu' : 'Show menu');
  btn.title = `${open ? 'Hide' : 'Show'} menu (Ctrl+B)`;
}
function toggleMenu() {
  if (narrow()) $('#sidebar').classList.toggle('open');
  else {
    const collapsed = document.body.classList.toggle('nav-collapsed');
    try { localStorage.setItem(NAV_KEY, collapsed ? '1' : '0'); } catch { /* private window: not remembered */ }
  }
  syncMenuBtn();
}
try { if (localStorage.getItem(NAV_KEY) === '1') document.body.classList.add('nav-collapsed'); } catch { /* fine */ }
syncMenuBtn();
matchMedia('(max-width: 860px)').addEventListener('change', syncMenuBtn);
$('#menuBtn').addEventListener('click', toggleMenu);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b' && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    toggleMenu();
  }
});
$('#standupAllBtn').addEventListener('click', async () => {
  if (!confirm(`Write a stand-up for all ${S.projects.length} projects now? Each one is a Claude run.`)) return;
  try {
    const made = await api('/api/reports/run', { method: 'POST', body: {} });
    toast(`${made.length} stand-up(s) queued`);
  } catch (err) { toast(err.message, true); }
});

// The theme lives in the config (Settings > Appearance); localStorage only avoids a flash of the
// wrong theme before the state has loaded.
function setTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('devcrew-theme', t || ''); } catch { /* private mode */ }
}
try { setTheme(localStorage.getItem('devcrew-theme') || ''); } catch { /* ignore */ }
$('#themeBtn').addEventListener('click', async () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = dark ? 'light' : 'dark';
  setTheme(theme);
  try { await api('/api/settings', { method: 'PUT', body: { ui: { theme } } }); } catch (e) { toast(e.message, true); }
});

window.addEventListener('hashchange', () => {
  if (openTaskLink()) return;
  closeDrawer(); render(); window.scrollTo(0, 0); $('#sidebar').classList.remove('open'); syncMenuBtn();
});
setInterval(() => { if (S) schedule(); }, 30000); // keep "5m ago" honest

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* system notifications stay off */ });
  // a notification button asked the open page to show something
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'devcrew-open') { const h = new URL(e.data.url, location.href).hash; if (h) location.hash = h; }
  });
}

load().then(() => { openTaskLink(); }).then(connect).catch(e => {
  $('#main').innerHTML = `<div class="notice"><b>Could not reach the Dev Crew server.</b> ${esc(e.message)}</div>`;
});

// Enter inside the integration editor must not submit the whole Settings form.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.closest && e.target.closest('.int-editor') && e.target.tagName === 'INPUT') e.preventDefault();
});
