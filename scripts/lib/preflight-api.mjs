/**
 * The direct check of the API server in `npm run device:preflight` (scripts/device-preflight.mjs).
 *
 * The preflight checks the API twice: once through the Vite proxy on the tailnet host, the path a phone
 * takes, and once directly. The direct check used to ask `http://localhost:<PORT>` alone, so it was only
 * right on the box that serves the app. Run from a dev Mac against another box, it always failed, even
 * with that box healthy and its proxy check passing.
 *
 * Now:
 * - `API_URL`, the name the Playwright `api` project and `npm run test:box` already use for the API
 *   server's own address, says where the direct check goes. A failure there is a failure.
 * - Without it, the check asks localhost, as before. When nothing answers there, and the host is not
 *   this machine's own Tailscale name, and the proxy check reached the host's API, it is a warning that
 *   says how to check that API directly. On the box itself, or with the proxy failing too, it stays a
 *   failure.
 */

/** Where the direct check goes: `API_URL` when it is set, else this machine's API port. */
export function directApiTarget(env, port) {
  const explicit = String(env.API_URL ?? '').trim().replace(/\/+$/, '')
  return explicit
    ? { url: `${explicit}/health`, explicit: true }
    : { url: `http://localhost:${port}/health`, explicit: false }
}

/**
 * PASS, WARN or FAIL for the direct check.
 *
 * @param {object} check
 * @param {boolean} check.reached      the direct check answered 200
 * @param {boolean} check.explicit     `API_URL` named the address
 * @param {boolean} check.onThisBox    the host is this machine's own Tailscale name
 * @param {boolean} check.proxyHealthy the check through the Vite proxy answered 200
 */
export function directApiVerdict({ reached, explicit, onThisBox, proxyHealthy }) {
  if (reached) return 'PASS'
  if (!explicit && !onThisBox && proxyHealthy) return 'WARN'
  return 'FAIL'
}

/** This machine's own Tailscale name from `tailscale status --json`, without the trailing dot, or null. */
export function ownTailscaleName(status) {
  const name = status?.Self?.DNSName
  return typeof name === 'string' && name ? name.replace(/\.$/, '') : null
}
