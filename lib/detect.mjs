// "Add project": look at a folder, find its git repos and work out the tech stack from the files
// in them, then suggest which crew roles the project needs and draft its context from the docs.
// Local and free: it only reads files. Nothing is written.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', '.vs', '.idea', '.vscode', 'coverage', 'vendor', 'packages', '__pycache__', '.venv', 'venv', 'graphify-out']);
const MAX_FILES = 4000;
const MAX_DEPTH = 4;

const isRepo = p => fs.existsSync(path.join(p, '.git'));
const read = (p, max = 200000) => { try { return fs.readFileSync(p, 'utf8').slice(0, max); } catch { return ''; } };
const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name)).map(d => d.name); } catch { return []; } };

/** Git repos in a folder: the folder itself, or repos up to two levels down. */
export function findRepos(folder) {
  if (isRepo(folder)) return [{ name: path.basename(folder), path: folder }];
  const out = [];
  for (const d1 of dirs(folder)) {
    const p1 = path.join(folder, d1);
    if (isRepo(p1)) { out.push({ name: d1, path: p1 }); continue; }
    for (const d2 of dirs(p1)) {
      const p2 = path.join(p1, d2);
      if (isRepo(p2)) out.push({ name: `${d1}/${d2}`, path: p2 });
    }
  }
  return out;
}

/** Relative paths of the files in a repo (skipping build output and dependencies). */
function listFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name);
        // A nested repo or worktree (e.g. Dev Crew's own data/worktrees) is another codebase: skip it.
        if (!SKIP.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github') && !fs.existsSync(path.join(sub, '.git'))) walk(sub, depth + 1);
      } else if (e.isFile()) {
        files.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/'));
      }
    }
  };
  walk(root, 0);
  return files;
}

const dotnetVersion = tfm => {
  const m = /^net(\d+)\.(\d+)/.exec(tfm) || /^netcoreapp(\d+)\.(\d+)/.exec(tfm);
  return m ? `.NET ${Number(m[1]) >= 5 ? m[1] : `Core ${m[1]}.${m[2]}`}` : '';
};

/**
 * What one repo is built with. Returns { stack: [labels], kinds: Set of
 * 'frontend'|'backend'|'database'|'devops'|'tests', commands: [] }.
 */
export function detectRepo(repoPath) {
  const files = listFiles(repoPath);
  const has = re => files.some(f => re.test(f));
  const stack = [];
  const kinds = new Set();
  const add = (label, ...k) => { if (!stack.includes(label)) stack.push(label); for (const x of k) kinds.add(x); };

  // .NET
  const projs = files.filter(f => f.endsWith('.csproj') || f.endsWith('.fsproj'));
  if (projs.length || has(/\.sln$/)) {
    const text = projs.map(f => read(path.join(repoPath, f))).join('\n');
    const tfms = [...new Set([...text.matchAll(/<TargetFrameworks?>([^<]+)</g)].flatMap(m => m[1].split(';')).map(dotnetVersion).filter(Boolean))];
    const web = /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(text);
    add(`${tfms.join(' / ') || '.NET'}${web ? ' ASP.NET Core Web API' : ''} (C#)`, web ? 'backend' : 'backend');
    if (/Microsoft\.EntityFrameworkCore/.test(text)) add('EF Core', 'database');
    if (/Dapper/.test(text)) add('Dapper', 'database');
    if (/Hangfire/.test(text)) add('Hangfire background jobs', 'backend');
    if (/SignalR/.test(text) || has(/Hub\.cs$/)) add('SignalR', 'backend');
    if (/Swashbuckle|NSwag/.test(text)) add('Swagger', 'backend');
    if (/xunit|NUnit|MSTest/i.test(text)) add('.NET tests', 'tests');
    if (/JwtBearer/.test(text)) add('JWT auth', 'backend');
  }

  // Node / web
  const pkgFiles = files.filter(f => /(^|\/)package\.json$/.test(f)).slice(0, 10);
  for (const f of pkgFiles) {
    let pkg;
    try { pkg = JSON.parse(read(path.join(repoPath, f))); } catch { continue; }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const d = n => Object.prototype.hasOwnProperty.call(deps, n);
    if (d('@angular/core')) add('Angular', 'frontend');
    if (d('react')) add(d('next') ? 'Next.js (React)' : 'React', 'frontend');
    if (d('vue')) add(d('nuxt') ? 'Nuxt (Vue)' : 'Vue', 'frontend');
    if (d('svelte')) add('Svelte', 'frontend');
    if (d('express')) add('Express', 'backend');
    if (d('@nestjs/core')) add('NestJS', 'backend');
    if (d('fastify')) add('Fastify', 'backend');
    if (d('typescript')) add('TypeScript');
    if (d('prisma') || d('@prisma/client')) add('Prisma', 'database');
    if (d('typeorm') || d('sequelize') || d('knex')) add('SQL ORM', 'database');
    if (d('jest') || d('vitest') || d('karma') || d('jasmine-core')) add('unit tests', 'tests');
    if (d('@playwright/test') || d('cypress')) add('e2e tests', 'tests');
    if (!stack.some(s => /Angular|React|Vue|Svelte|Next|Nuxt|Express|NestJS|Fastify/.test(s))) add('Node.js', 'backend');
  }

  // JVM, Python, Go, Rust
  if (has(/(^|\/)pom\.xml$/)) { const t = read(path.join(repoPath, files.find(f => /(^|\/)pom\.xml$/.test(f)))); add(/spring-boot/.test(t) ? 'Java Spring Boot (Maven)' : 'Java (Maven)', 'backend'); }
  if (has(/(^|\/)build\.gradle(\.kts)?$/)) add('JVM (Gradle)', 'backend');
  if (has(/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.py)$/)) {
    const t = files.filter(f => /(requirements[^/]*\.txt|pyproject\.toml)$/.test(f)).map(f => read(path.join(repoPath, f))).join('\n').toLowerCase();
    add(/django/.test(t) ? 'Python Django' : /fastapi/.test(t) ? 'Python FastAPI' : /flask/.test(t) ? 'Python Flask' : 'Python', 'backend');
    if (/pytest/.test(t) || has(/(^|\/)test_[^/]+\.py$/)) add('pytest', 'tests');
  }
  if (has(/(^|\/)go\.mod$/)) add('Go', 'backend');
  if (has(/(^|\/)Cargo\.toml$/)) add('Rust', 'backend');

  // Data
  if (has(/(^|\/)Migrations\/.+\.cs$/)) add('EF Core migrations', 'database');
  if (has(/\.sql$/)) add('SQL scripts', 'database');
  if (has(/(^|\/)(flyway|liquibase)/i)) add('DB migrations', 'database');

  // Delivery
  if (has(/(^|\/)Dockerfile$/)) add('Docker', 'devops');
  if (has(/(^|\/)docker-compose[^/]*\.ya?ml$/)) add('docker-compose', 'devops');
  if (has(/(^|\/)azure-pipelines[^/]*\.ya?ml$/)) add('Azure DevOps Pipelines', 'devops');
  if (has(/^\.github\/workflows\/.+\.ya?ml$/)) add('GitHub Actions', 'devops');
  if (has(/(^|\/)Jenkinsfile$/)) add('Jenkins', 'devops');
  if (has(/(^|\/)\.gitlab-ci\.yml$/) || fs.existsSync(path.join(repoPath, '.gitlab-ci.yml'))) add('GitLab CI', 'devops');
  if (has(/\.tf$/)) add('Terraform', 'devops');
  if (has(/\.bicep$/)) add('Bicep', 'devops');
  if (has(/(^|\/)Chart\.yaml$/)) add('Helm', 'devops');

  return { stack, kinds, files: files.length };
}

/** The first real paragraph of a Markdown file (skips headings, badges, code and templates). */
export function firstParagraph(md) {
  const lines = String(md || '').replace(/```[\s\S]*?```/g, '').split(/\r?\n/);
  const paras = [];
  let cur = [];
  for (const raw of lines) {
    const l = raw.trim();
    const skip = !l || l.startsWith('#') || l.startsWith('|') || l.startsWith('---') || l.startsWith('<') || l.startsWith('>')
      || /^!\[|^\[!\[/.test(l) || /^([-*+]|\d+[.)])\s/.test(l); // headings, tables, quotes, badges, list items
    if (skip) { if (cur.length) { paras.push(cur.join(' ')); cur = []; } continue; }
    cur.push(l);
  }
  if (cur.length) paras.push(cur.join(' '));
  // Prefer a paragraph that says what the project is; avoid notes about the doc itself or setup.
  const score = p => (/\b(is an?|is the|lets|helps|provides|platform|service|application|system|tool)\b/i.test(p) ? 3 : 0)
    - (/mermaid|diagram|render|markdown|extension|install|npm |dotnet |clone|prerequisite/i.test(p) ? 4 : 0);
  const good = paras.slice(0, 10)
    .filter(p => p.length >= 60 && !p.endsWith(':') && !/^(this|the) (readme|repository|repo|template)|getting started|bitbucket|^readme/i.test(p.slice(0, 40)) && !/would normally document/i.test(p))
    .map((p, i) => ({ p, s: score(p) - i * 0.1 }))
    .sort((a, b) => b.s - a.s)[0];
  return good && good.s > -2 ? good.p.replace(/\*\*|__/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 600) : '';
}

/** A project context drafted from an overview doc, else the README. */
function draftContext(repos) {
  for (const r of repos) {
    const docs = ['docs', 'doc', '.'].flatMap(d => {
      try { return fs.readdirSync(path.join(r.path, d)).filter(f => /overview|architecture|about/i.test(f) && f.endsWith('.md')).map(f => path.join(r.path, d, f)); } catch { return []; }
    });
    for (const f of docs) { const p = firstParagraph(read(f)); if (p) return p; }
  }
  for (const r of repos) {
    for (const f of ['README.md', 'readme.md', 'Readme.md']) { const p = firstParagraph(read(path.join(r.path, f))); if (p) return p; }
  }
  return '';
}

export const slugId = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const titleCase = s => String(s).replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, c => c.toUpperCase()).trim();

const ROLE_FOR_KIND = { frontend: 'frontend', backend: 'backend', database: 'database', devops: 'devops' };

/**
 * Look at a folder and propose a project: { name, id, repos, stack, context, activeRoles, roles, signals }.
 * activeRoles always has the architect and QA; the others only when the repos need them.
 */
export function detectProject(folder) {
  const repos = findRepos(folder);
  const per = repos.map(r => ({ ...r, ...detectRepo(r.path) }));
  const stack = [...new Set(per.flatMap(r => r.stack))];
  const roles = {};
  const active = new Set(['architect', 'qa']);
  for (const kind of Object.keys(ROLE_FOR_KIND)) {
    // the repo with the most signals of this kind does this role's work
    const best = per.filter(r => r.kinds.has(kind)).sort((a, b) => b.stack.length - a.stack.length)[0];
    if (best) { active.add(ROLE_FOR_KIND[kind]); roles[ROLE_FOR_KIND[kind]] = { repo: best.name }; }
  }
  const main = per.slice().sort((a, b) => b.stack.length - a.stack.length)[0];
  if (main) for (const r of ['architect', 'qa']) roles[r] = { repo: main.name };
  const order = ['architect', 'frontend', 'backend', 'database', 'qa', 'devops'];
  const name = titleCase(path.basename(folder));
  return {
    folder,
    name,
    id: slugId(path.basename(folder)),
    repos: per.map(r => ({ name: r.name, path: r.path, stack: r.stack })),
    stack: stack.join(', '),
    context: draftContext(repos),
    activeRoles: order.filter(r => active.has(r)),
    roles,
  };
}
