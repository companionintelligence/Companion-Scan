// Who may drive the gimbal backend, and which files the page server hands out, as pure rules.
//
// Why: the backend drives real motors over the network. It used to answer every origin with
// Access-Control-Allow-Origin * and check no credential, on every interface. So any web page the
// operator happened to open could POST /api/command and move the gimbal, and anything that could
// reach the port could do the same. CORS alone never stopped the side effect: a "simple"
// cross-site POST (no Content-Type) skips the preflight, so it ran, and only its answer was hidden.
//
// Three settings, each optional, read from the shell that starts the backend:
//
//   OSMO_BACKEND_TOKEN       A shared secret. Unset means no check (the old behaviour). Set, every
//                            route except the CORS preflight needs `Authorization: Bearer <token>`.
//                            The /ws upgrade takes it as `?token=`, because a browser cannot put
//                            headers on a WebSocket. The CLI and the MCP server read the same
//                            variable, so there is one name for one secret (ADR 0001).
//   BACKEND_ALLOWED_ORIGINS  Which browser origins may call it. Unset means the Gimbal control page's
//                            own origin (see pageOriginAllowed). A comma list of whole origins
//                            replaces that; `*` restores the old open behaviour.
//   BACKEND_HOST             The bind address. Unset means every interface, the old behaviour. The
//                            documented rig needs it: the operator's phone opens the page and the
//                            backend over the network.
//
// The origin check runs on the server, before any handler, and it is the gate. The CORS headers
// only decide what a browser lets a page read. A request with no Origin header comes from no
// browser page (the CLI, the MCP server, curl), so it is never refused for its origin; the token,
// when set, is what covers it.
//
// The rules are written in parallel to server/origin.ts (the main app's rules, in its server), not shared
// with it. That is a different listener with a different trust boundary, in a different runtime.
// They share its matching rules: whole origins only (never startsWith), and never the literal "null".

import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

/** The page server's default port (web/server.mjs). The default origin rule expects the page here. */
export const DEFAULT_WEB_PORT = 8787;

/** A token shorter than this is accepted, with a warning at boot. */
const SHORT_TOKEN_CHARS = 16;

/**
 * A bind address from the environment, or null for every interface.
 *
 * @param {string|undefined} value
 * @returns {string|null}
 */
export function parseBindHost(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim();
  return host ? host : null;
}

/**
 * The whole origin of `value` (`scheme://host[:port]`, host lower-cased, default port dropped), or
 * null. An origin carries no path, query, fragment or credentials, so a value with any of them is
 * not one. Only http and https.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function bareOrigin(value) {
  if (typeof value !== 'string' || !value || value === 'null') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' || /^[a-z]+:\/\/[^/]+\/./i.test(value)) return null;
  return url.origin;
}

/**
 * The allowlist entry form of a configured origin: the same as bareOrigin, but a trailing slash
 * is forgiven, because people paste origins out of an address bar.
 */
function configuredOrigin(value) {
  return bareOrigin(value.replace(/\/+$/, ''));
}

/**
 * Read the three access settings, plus anything wrong with them, which is reported at boot rather
 * than thrown. A typo in an allowlist must not take the backend down mid-session; it just does not
 * admit that origin.
 *
 * @param {Record<string, string|undefined>} env
 */
export function parseAccessSettings(env = {}) {
  const problems = [];
  const rawToken = typeof env.OSMO_BACKEND_TOKEN === 'string' ? env.OSMO_BACKEND_TOKEN.trim() : '';
  const token = rawToken || null;
  if (token && token.length < SHORT_TOKEN_CHARS) {
    problems.push(`OSMO_BACKEND_TOKEN is ${token.length} characters; use at least ${SHORT_TOKEN_CHARS} random ones.`);
  }

  const rawOrigins = typeof env.BACKEND_ALLOWED_ORIGINS === 'string' ? env.BACKEND_ALLOWED_ORIGINS.trim() : '';
  let origins;
  if (!rawOrigins) {
    origins = { mode: 'page', webPort: DEFAULT_WEB_PORT };
  } else {
    const parts = rawOrigins.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.includes('*')) {
      origins = { mode: 'any' };
    } else {
      const list = new Set();
      for (const part of parts) {
        const origin = configuredOrigin(part);
        if (origin) list.add(origin);
        else problems.push(`BACKEND_ALLOWED_ORIGINS: ignored ${JSON.stringify(part)}, which is not an http(s) origin such as http://host:8787.`);
      }
      origins = { mode: 'list', list };
    }
  }

  return { token, origins, host: parseBindHost(env.BACKEND_HOST), problems };
}

/** A one-line description of the settings for the boot log. Never includes the token. */
export function describeAccess(settings) {
  const origins = settings.origins.mode === 'any'
    ? 'any origin (BACKEND_ALLOWED_ORIGINS=*)'
    : settings.origins.mode === 'list'
      ? `only ${[...settings.origins.list].join(', ') || '(none: the list had no valid entry)'}`
      : `the Gimbal control page's own origin (port ${settings.origins.webPort} on the host this backend is reached at)`;
  return `browser origins: ${origins}; token: ${settings.token ? 'required (OSMO_BACKEND_TOKEN)' : 'not set'}; `
    + `bind: ${settings.host ?? 'every interface'}`;
}

/** The host name a request was addressed to, from its Host header, lower-cased, or null. */
export function requestHostname(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname || null;
  } catch {
    return null;
  }
}

/** A loopback name: localhost (and *.localhost), 127.0.0.0/8, or [::1]. */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string') return false;
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The default origin rule: the page is the Gimbal control page, served by web/server.mjs on this
 * same machine.
 *
 * The page's port must be the page server's, and its host must be the host the browser used to
 * reach this backend. A loopback page may also call a loopback backend, whichever loopback name
 * each uses. That covers the documented rig: a phone opens http://<machine>:8787 and points the
 * page at http://<machine>:8788, under the same name.
 *
 * Both names come from the browser, so a DNS-rebinding page served on port 8787 also passes. The
 * token, an explicit BACKEND_ALLOWED_ORIGINS, or BACKEND_HOST=127.0.0.1 closes that; the README says
 * so.
 */
function pageOriginAllowed(origin, hostHeader, webPort) {
  const url = new URL(origin);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== String(webPort)) return false;
  const requestHost = requestHostname(hostHeader);
  if (!requestHost) return false;
  return url.hostname === requestHost || (isLoopbackHost(url.hostname) && isLoopbackHost(requestHost));
}

/**
 * Whether a request's Origin may call the backend.
 *
 * @param {{ origin?: string, hostHeader?: string, settings: ReturnType<typeof parseAccessSettings> }} facts
 * @returns {{ ok: true, browser: boolean } | { ok: false, status: 403, error: string, remediation: string }}
 */
export function originDecision({ origin, hostHeader, settings }) {
  if (origin === undefined || origin === null || origin === '') return { ok: true, browser: false };
  if (settings.origins.mode === 'any') return { ok: true, browser: true };
  const normalized = bareOrigin(origin);
  if (normalized) {
    if (settings.origins.mode === 'list' && settings.origins.list.has(normalized)) return { ok: true, browser: true };
    if (settings.origins.mode === 'page' && pageOriginAllowed(normalized, hostHeader, settings.origins.webPort)) {
      return { ok: true, browser: true };
    }
  }
  const remediation = !normalized
    ? 'A page with an opaque origin (a file:// page or a sandboxed frame) cannot be allowed. Serve it over http(s).'
    : settings.origins.mode === 'page'
      ? `By default only the Gimbal control page's own origin is accepted: port ${settings.origins.webPort}, on the `
        + 'host this backend was reached at. To allow this page, start the backend with '
        + `BACKEND_ALLOWED_ORIGINS=${normalized} (a comma-separated list of origins), or with `
        + "BACKEND_ALLOWED_ORIGINS='*' to accept any origin as before."
      : `Add ${normalized} to BACKEND_ALLOWED_ORIGINS (a comma-separated list) in the shell that starts the backend.`;
  return { ok: false, status: 403, error: `This backend does not accept requests from a page at ${origin}.`, remediation };
}

/** Constant-time comparison of two secrets. The length is not secret; timingSafeEqual needs it equal. */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request carries the token, when one is configured.
 *
 * The query form (`?token=`) is accepted only where a header cannot be set, on the /ws upgrade.
 * Nothing here ever puts the token in a message.
 *
 * @returns {{ ok: true } | { ok: false, status: 401, error: string, remediation: string }}
 */
export function tokenDecision({ authorization, queryToken, settings, allowQuery = false }) {
  if (!settings.token) return { ok: true };
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(typeof authorization === 'string' ? authorization : '')?.[1] ?? null;
  const candidate = bearer ?? (allowQuery && typeof queryToken === 'string' && queryToken ? queryToken : null);
  if (candidate && sameSecret(candidate, settings.token)) return { ok: true };
  return {
    ok: false,
    status: 401,
    error: candidate ? 'Wrong backend token.' : 'This backend needs a token.',
    remediation: 'Send Authorization: Bearer <the OSMO_BACKEND_TOKEN the backend was started with>. The CLI and '
      + 'the MCP server read OSMO_BACKEND_TOKEN from their own environment; the Gimbal control page has a '
      + 'token field under Connect, Advanced.'
      + (allowQuery ? ' A WebSocket passes it as ?token= on /ws.' : ''),
  };
}

/**
 * The whole access ruling for one request: origin first, then token.
 *
 * A CORS preflight passes without either. It cannot carry the token, and it runs nothing: the
 * request it precedes is judged here on its own.
 */
export function decideAccess({ method, origin, hostHeader, authorization, queryToken, upgrade = false, settings }) {
  if (method === 'OPTIONS' && !upgrade) return { ok: true, preflight: true };
  const byOrigin = originDecision({ origin, hostHeader, settings });
  if (!byOrigin.ok) return byOrigin;
  const byToken = tokenDecision({ authorization, queryToken, settings, allowQuery: upgrade });
  if (!byToken.ok) return byToken;
  return { ok: true };
}

/**
 * CORS headers for one response.
 *
 * With BACKEND_ALLOWED_ORIGINS=* this is the old `*`. Otherwise the request's origin is reflected,
 * refused ones included. That is safe because the gate is decideAccess, which refuses before any
 * handler runs. It also lets a misconfigured page read the 403 that says which setting to change,
 * instead of a bare network error. The literal "null" origin is never reflected.
 */
export function corsHeaders({ origin, settings }) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
  if (settings.origins.mode === 'any') return { ...headers, 'Access-Control-Allow-Origin': '*' };
  if (typeof origin !== 'string' || !origin || origin === 'null') return headers;
  return { ...headers, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/**
 * The file the page server (web/server.mjs) should send for a request URL, or null.
 *
 * Only what the page loads is served: `web/` and `protocol/`. The page imports nothing else, and the
 * service worker caches nothing else. The server used to serve the whole subsystem, including the
 * CLI's remembered-device file and node_modules. It also checked `startsWith(root)`, which a sibling
 * directory with the same prefix passes (`/../osmo-ble-other/x`).
 *
 * @param {string} root  the subsystem directory
 * @param {string} rawUrl  the request URL, query included
 * @returns {{ file: string } | { status: 400 | 404 }}
 */
export function servedFilePath(root, rawUrl, dirs = ['web', 'protocol']) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(String(rawUrl ?? '').split('?')[0]);
  } catch {
    // A malformed %-escape used to throw out of the request handler and take the server down.
    return { status: 400 };
  }
  if (urlPath.includes('\0')) return { status: 400 };
  // A directory URL is its index.html. The service worker precaches './', which is /web/, and a 404
  // there fails the whole cache.addAll, so the offline shell never installed.
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(root, urlPath));
  const inside = dirs.some((dir) => file.startsWith(path.join(root, dir) + path.sep));
  return inside ? { file } : { status: 404 };
}
