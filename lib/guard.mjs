// Request checks for the local API. The server only listens on 127.0.0.1, but any web page the
// owner visits can still send requests to localhost, and a DNS-rebinding page can even read the
// responses. These checks make sure only the dashboard itself can drive the crew:
//  - Host must be this machine at our port (stops DNS rebinding).
//  - Origin, when the browser sends one, must be the dashboard's own origin.
//  - Anything that changes state must carry the X-Dev-Crew header. A custom header forces a CORS
//    preflight, which this server never approves, so other sites cannot send it.
//  - A request body must be JSON (no text/plain or form posts dressed up as JSON).

export const CSRF_HEADER = 'x-dev-crew';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const allowedHosts = port => new Set(LOCAL_HOSTS.map(h => `${h}:${port}`));
const allowedOrigins = port => new Set(LOCAL_HOSTS.map(h => `http://${h}:${port}`));

/**
 * Returns null when the request may go ahead, or { code, error } to reject it.
 * `headers` are Node's lower-cased incoming headers.
 */
export function checkRequest({ method, pathname, headers, port }) {
  const host = String(headers.host || '').toLowerCase();
  if (!allowedHosts(port).has(host)) {
    return { code: 403, error: 'Requests must be made to localhost.' };
  }

  // No Origin is fine (same-origin GETs, curl). Any Origin, including the opaque "null" a
  // sandboxed page sends, must be the dashboard's own.
  const origin = headers.origin;
  if (origin !== undefined && !allowedOrigins(port).has(String(origin).toLowerCase())) {
    return { code: 403, error: 'Cross-site requests are not allowed.' };
  }

  if (!pathname.startsWith('/api/')) return null;

  const safe = method === 'GET' || method === 'HEAD';
  if (!safe) {
    if (headers[CSRF_HEADER] !== '1') {
      return { code: 403, error: `Missing ${CSRF_HEADER} header.` };
    }
    const hasBody = Number(headers['content-length'] || 0) > 0 || !!headers['transfer-encoding'];
    const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (hasBody && type !== 'application/json') {
      return { code: 415, error: 'Request body must be application/json.' };
    }
  }
  return null;
}
