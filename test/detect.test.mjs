import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProject, findRepos, firstParagraph, slugId } from '../lib/detect.mjs';

function scaffold(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devcrew-detect-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (rel.endsWith('/.git/HEAD')) fs.writeFileSync(p, 'ref: refs/heads/main\n');
    else fs.writeFileSync(p, body);
  }
  return root;
}

test('detects a .NET API with EF Core, Docker and Azure Pipelines', () => {
  const root = scaffold({
    'billing-api/.git/HEAD': '',
    'billing-api/Billing.sln': '',
    'billing-api/src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" /><PackageReference Include="Swashbuckle.AspNetCore" /></ItemGroup></Project>',
    'billing-api/src/Api/Migrations/20240101_Init.cs': '',
    'billing-api/Dockerfile': '',
    'billing-api/azure-pipelines.yml': '',
    'billing-api/docs/PROJECT_OVERVIEW.md': '# Billing\n\nBilling is the invoicing platform for enterprise customers, with a release train every second Tuesday.\n',
    'billing-web/.git/HEAD': '',
    'billing-web/package.json': JSON.stringify({ dependencies: { '@angular/core': '17' }, devDependencies: { typescript: '5', karma: '6' } }),
  });
  try {
    const p = detectProject(root);
    assert.deepEqual(p.repos.map(r => r.name).sort(), ['billing-api', 'billing-web']);
    for (const s of ['.NET 8 ASP.NET Core Web API (C#)', 'EF Core', 'Swagger', 'EF Core migrations', 'Docker', 'Azure DevOps Pipelines', 'Angular', 'TypeScript']) {
      assert.ok(p.stack.includes(s), `stack should mention ${s}: ${p.stack}`);
    }
    assert.deepEqual(p.activeRoles, ['architect', 'frontend', 'backend', 'database', 'qa', 'devops']);
    assert.equal(p.roles.frontend.repo, 'billing-web');
    assert.equal(p.roles.backend.repo, 'billing-api');
    assert.equal(p.roles.devops.repo, 'billing-api');
    assert.match(p.context, /invoicing platform/);
    assert.equal(p.id, slugId(path.basename(root)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a backend-only repo gets no frontend role', () => {
  const root = scaffold({ '.git/HEAD': '', 'go.mod': 'module x', 'main_test.go': '' });
  try {
    const p = detectProject(root);
    assert.equal(p.repos.length, 1);
    assert.match(p.stack, /Go/);
    assert.ok(!p.activeRoles.includes('frontend'));
    assert.ok(!p.activeRoles.includes('devops'));
    assert.deepEqual(p.activeRoles, ['architect', 'backend', 'qa']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nested repos and worktrees inside a repo are not counted as its stack', () => {
  const root = scaffold({
    '.git/HEAD': '', 'package.json': JSON.stringify({ dependencies: { express: '4' } }),
    'data/worktrees/x/t1/.git': 'gitdir: elsewhere', 'data/worktrees/x/t1/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  });
  try {
    const p = detectProject(root);
    assert.equal(p.stack, 'Express');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findRepos looks two levels down and skips dependency folders', () => {
  const root = scaffold({ 'a/.git/HEAD': '', 'group/b/.git/HEAD': '', 'node_modules/c/.git/HEAD': '' });
  try {
    assert.deepEqual(findRepos(root).map(r => r.name).sort(), ['a', 'group/b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('firstParagraph skips headings, badges and template text', () => {
  const md = '# Title\n\n[![build](x)](y)\n\nThis README would normally document whatever steps are necessary.\n\nThe Payments Portal lets customers pay invoices by card and see their history.\nIt runs on Azure.\n';
  assert.equal(firstParagraph(md), 'The Payments Portal lets customers pay invoices by card and see their history. It runs on Azure.');
  assert.equal(firstParagraph('# Only a heading'), '');
});
