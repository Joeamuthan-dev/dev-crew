// Native Windows notifications from the Dev Crew server, so they arrive even when no browser is
// open. Uses Windows PowerShell's built-in toast API (no extra software). Buttons open a URL:
// the task in the dashboard, or a one-time action link (start a plan, start a handoff).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Windows PowerShell's own app id: an unpackaged program may show toasts under it.
export const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
export const toastSupported = (platform = process.platform) => platform === 'win32';

const xmlEsc = s => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** The toast's XML: title, body, "Dev Crew", and up to three buttons that each open a URL. */
export function toastXml({ title, body, launch, buttons = [], urgent = false }) {
  const acts = buttons.slice(0, 3).map(b => `<action content="${xmlEsc(b.label)}" activationType="protocol" arguments="${xmlEsc(b.url)}"/>`).join('');
  return `<toast activationType="protocol" launch="${xmlEsc(launch || '')}"${urgent ? ' scenario="reminder"' : ''}>`
    + `<visual><binding template="ToastGeneric"><text>${xmlEsc(String(title).slice(0, 120))}</text><text>${xmlEsc(String(body || '').slice(0, 300))}</text><text placement="attribution">Dev Crew</text></binding></visual>`
    + (acts ? `<actions>${acts}${urgent ? '<action content="Dismiss" activationType="system" arguments="dismiss"/>' : ''}</actions>` : '')
    + '<audio src="ms-winsoundevent:Notification.Default"/></toast>';
}

/** The PowerShell script that shows one toast. */
export function toastScript(xml, tag = '') {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml(${q(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `$toast.Tag = ${q(String(tag).replace(/[^\w.-]/g, '').slice(0, 60) || 'devcrew')}`,
    "$toast.Group = 'devcrew'",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${q(TOAST_APP_ID)}).Show($toast)`,
  ].join('\n');
}

/** Show a toast. Resolves { ok, error }; never throws. */
export function showToast(opts) {
  if (!toastSupported()) return Promise.resolve({ ok: false, error: 'Windows notifications only work on Windows.' });
  const script = toastScript(toastXml(opts), opts.tag);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    // Windows PowerShell 5.1 (not pwsh): it has the Windows Runtime toast types built in
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 }, (err, out, errOut) => {
      resolve(err ? { ok: false, error: String(errOut || err.message).trim().split('\n').slice(0, 2).join(' ').slice(0, 300) } : { ok: true });
    });
  });
}

/* ---------------- one-time action links ---------------- */

// A toast button can only open a URL, so "Start plan" opens /act/<token>. The token is random,
// works once, and expires; nothing else is reachable that way.
export function createActionLinks({ ttlMs = 24 * 3600e3, now = () => Date.now() } = {}) {
  const links = new Map();
  return {
    make(action) {
      for (const [k, v] of links) if (v.expires < now()) links.delete(k);
      const token = randomBytes(18).toString('base64url');
      links.set(token, { ...action, expires: now() + ttlMs });
      return token;
    },
    /** Take a token: its action once, then null. */
    take(token) {
      const a = links.get(token);
      if (!a) return null;
      links.delete(token);
      return a.expires >= now() ? a : null;
    },
    size: () => links.size,
  };
}
