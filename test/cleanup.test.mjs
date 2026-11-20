import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical } from '../lib/cleanup.mjs';

test('canonical: the same folder written different ways compares equal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcrew-canon-'));
  try {
    const sub = path.join(dir, 'Work', 'tA');
    fs.mkdirSync(sub, { recursive: true });
    const forms = [sub, sub.replace(/\\/g, '/'), path.join(dir, 'Work', '.', 'tA'), path.join(dir, 'Work', 'x', '..', 'tA')];
    if (process.platform === 'win32') forms.push(sub.toUpperCase());
    const want = canonical(sub);
    for (const f of forms) assert.equal(canonical(f), want, f);
    assert.notEqual(canonical(path.join(dir, 'Work', 'tB')), want);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
