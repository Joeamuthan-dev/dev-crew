// Dev Crew's service worker: only for system notifications and their buttons. It caches nothing.
// A notification carries what each button does: open a page of the dashboard, or call the local
// API (same origin, with the X-Dev-Crew header the server requires for changes).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function openPage(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const mine = all.find(c => new URL(c.url).origin === self.location.origin);
  if (mine) {
    await mine.focus();
    // tell the open page where to go (it handles hash routes itself)
    mine.postMessage({ type: 'devcrew-open', url });
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', event => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  const act = (data.actions || {})[event.action] || null;
  event.waitUntil((async () => {
    if (!act || act.kind === 'open') return openPage(act ? act.url : data.url);
    // a button that does something straight away (start a plan, start a handoff)
    try {
      const res = await fetch(act.path, { method: act.method || 'POST', headers: { 'x-dev-crew': '1', 'content-type': 'application/json' }, body: JSON.stringify(act.body || {}) });
      const body = await res.json().catch(() => ({}));
      await self.registration.showNotification(res.ok ? (act.doneText || 'Done') : 'Dev Crew could not do that', {
        body: res.ok ? (act.doneBody || '') : (body.error || `HTTP ${res.status}`),
        tag: `${n.tag}:result`,
        data: { url: data.url },
        icon: '/icon.svg',
      });
    } catch (e) {
      await self.registration.showNotification('Dev Crew is not reachable', { body: 'Is it still running? ' + e.message, tag: `${n.tag}:result`, data: { url: data.url } });
    }
  })());
});
