/**
 * The access token a page was opened with (`?token=`), and how it rides on a request.
 *
 * The desktop world editor (src/viewer/viewer.ts) and the headset editor
 * (src/viewer/xr-world.ts) both talk to the Scan server with it, so the two share
 * this one definition.
 *
 * ## Where the token goes
 *
 * The access token is a world member's token. The server reads it from the `token` query
 * parameter first, then from a Bearer header (`requestToken` in server/main.ts), and only
 * world routes (`/worlds/...`, `/projects/:id/world`) check it.
 *
 *  - **A fetch** (and a loader that fetches: GLTFLoader, a SplatMesh URL). The token
 *    rides in the query, once. The `Authorization` header is left to the session: in a
 *    native shell it carries the Companion session that src/shared/shell-sign-in.ts adds
 *    to every fetch, and the server's session guard reads it there. Before, the editor set
 *    `Authorization: Bearer <access token>` itself, which stopped the shell from adding
 *    its own, so a shell opened with `?token=` failed the guard on every session-guarded
 *    read.
 *  - **An element that loads a URL by itself** (an `<img>` texture, a download link). It
 *    cannot send a header, so its one credential is the `token` parameter:
 *    {@link mediaUrl}.
 *
 * A URL never carries two `token` parameters. Hono's `query('token')` reads the first,
 * so a second one is never read.
 *
 * Only a server path that the page builds, a root-relative one such as `/scans/x.glb`,
 * gets a token. An absolute URL is someone else's, for example a splat typed into the
 * editor's External splat box, and must not be handed a credential.
 */
import { apiUrl, shellSessionToken, withTokenParameter } from './api-base.ts'

/** The `token` parameter of a page's query string, or '' when the page has none. */
export function accessTokenFrom(search: string): string {
  return new URLSearchParams(search).get('token') || ''
}

/** True for a path on the Scan server: root-relative, the rule `resolveApiUrl` uses. */
function isServerPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

/**
 * A server path as a URL to fetch, with `token` as its one `token` parameter. Without a
 * token only the server's origin is added (`apiUrl`). An absolute URL is returned as it
 * is: it is not a path on this server.
 */
export function addAccessToken(url: string, token: string): string {
  if (!isServerPath(url)) return url
  return withTokenParameter(apiUrl(url), token)
}

/**
 * A server path as a URL for an element that loads it by itself, with one `token`: the
 * credential the route checks.
 *
 * `/worlds/...` is the world's own route. It checks the world token and no session, so it
 * gets the access token. Any other path is behind the session guard once sign-in is on,
 * and no route there reads a world token, so a native shell's session token goes there
 * when the shell has one, and otherwise the access token. In a browser the session is a
 * cookie, so only the access token is ever added. An absolute URL is returned as it is.
 */
export function mediaUrl(url: string, accessToken: string, sessionToken: string | null = shellSessionToken()): string {
  if (!isServerPath(url)) return url
  const token = url.startsWith('/worlds/') ? accessToken : (sessionToken || accessToken)
  return withTokenParameter(apiUrl(url), token)
}

/**
 * `extra` plus an Authorization header carrying `token`. Unchanged without a token.
 *
 * The editors no longer call this: the header belongs to the session (see the header of
 * this file), and every URL {@link addAccessToken} builds already carries the token, which
 * the server reads first. Kept, unchanged, for any other importer.
 */
export function accessTokenHeaders(token: string, extra: HeadersInit = {}): HeadersInit {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra
}
