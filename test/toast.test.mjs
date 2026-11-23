import test from 'node:test';
import assert from 'node:assert/strict';
import { toastXml, toastScript, createActionLinks, toastSupported } from '../lib/toast.mjs';
import { cleanDesktopAlerts } from '../lib/settings.mjs';

test('toast XML escapes text and turns buttons into URL actions', () => {
  const x = toastXml({ title: 'Fix <b> & "quotes"', body: "it's done", launch: 'http://localhost:4610/#/t/1', buttons: [{ label: 'Review', url: 'http://localhost:4610/#/t/1?a=1&b=2' }] });
  assert.match(x, /Fix &lt;b&gt; &amp; &quot;quotes&quot;/);
  assert.match(x, /it&apos;s done/);
  assert.match(x, /<action content="Review" activationType="protocol" arguments="http:\/\/localhost:4610\/#\/t\/1\?a=1&amp;b=2"\/>/);
  assert.match(x, /placement="attribution">Dev Crew/);
  assert.doesNotMatch(toastXml({ title: 'x' }), /<actions>/);
  assert.equal((toastXml({ title: 'x', buttons: [1, 2, 3, 4].map(i => ({ label: `b${i}`, url: 'u' })) }).match(/<action /g) || []).length, 3);
});

test('the PowerShell script quotes single quotes and cleans the tag', () => {
  const s = toastScript("<toast a='1'/>", "bad tag;'x");
  assert.match(s, /LoadXml\('<toast a=''1''\/>'\)/);
  assert.match(s, /\$toast\.Tag = 'badtagx'/);
});

test('action links work once and expire', () => {
  let now = 1000;
  const l = createActionLinks({ ttlMs: 100, now: () => now });
  const a = l.make({ id: 'plan', taskId: 't1' });
  assert.equal(l.take(a).taskId, 't1');
  assert.equal(l.take(a), null);
  const b = l.make({ id: 'plan' });
  now += 200;
  assert.equal(l.take(b), null);
  assert.equal(l.take('nope'), null);
});

test('desktop alert settings: on by default on Windows, events merged with defaults', () => {
  assert.equal(cleanDesktopAlerts(undefined, 'win32').enabled, true);
  assert.equal(cleanDesktopAlerts(undefined, 'linux').enabled, false);
  const d = cleanDesktopAlerts({ enabled: false, events: { done: true, review: 'yes' } }, 'win32');
  assert.equal(d.enabled, false);
  assert.equal(d.events.done, true);
  assert.equal(d.events.review, true); // non-boolean ignored, default kept
  assert.equal(toastSupported('win32'), true);
  assert.equal(toastSupported('darwin'), false);
});
