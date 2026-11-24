/**
 * Request logging that never writes a query string.
 *
 * Hono's logger prints the full URL, query included. This app sends capability
 * tokens in query strings (`?token=` on share links and the owner link, the
 * Companion session on media and socket URLs), so the stock logger writes live
 * credentials to stdout. This keeps the same logger and drops the query from
 * every line it prints.
 */
import { logger } from 'hono/logger'

/**
 * Remove the query string from one request log line:
 * `--> GET /events?token=abc 101` becomes `--> GET /events 101`.
 */
export function stripQueryFromLogLine(line: string): string {
  return line.replace(/\?\S*/, '')
}

/** Hono's request logger, printing through `sink` with query strings removed. */
export function redactedRequestLogger(sink: (line: string) => void = console.log) {
  return logger((line: string) => sink(stripQueryFromLogLine(line)))
}

/**
 * Client-reported text (a log message or stack trace) with token-like parameters blanked, so a
 * URL pasted into a message cannot carry a credential into the log or the event stream.
 */
export function redactTokens(text: string): string {
  return text.replace(/([?&#](?:access_token|token|code|state|session)=)[^&\s"'<>#),\]}]*/gi, '$1[redacted]')
}

/** A client-reported page URL without its query string or fragment. Non-text input gives undefined. */
export function pageUrlWithoutQuery(url: unknown): string | undefined {
  return typeof url === 'string' ? url.split(/[?#]/, 1)[0] : undefined
}

/**
 * The paths this server answers at. A string that starts with one is a link into this API (an artifact's `url`, a
 * route named in a message), not a file on the server, and is left whole.
 */
const API_ROUTE_PREFIXES = ['/scans/', '/sessions/', '/worlds/', '/projects/', '/takes/', '/jobs/', '/authenticate/', '/editor', '/viewer.html', '/scanner.html']

/**
 * Text that is about to reach a client (an error reply, a job's error) with every server file path cut to its last
 * name: `No such file or directory (os error 2): readfile '/srv/scan/scans/a.glb'` becomes `…: readfile 'a.glb'`. A file
 * error names the path it failed on, and where this server keeps its files is no client's business (FN-118). The
 * detail stays in the server log, which is written before this is applied. A POSIX path is two or more segments after
 * a slash; a Windows path is a drive letter and a backslash. A link into this API is not a file and is left whole.
 */
export function withoutServerPaths(text: string): string {
  return text
    .replace(/(^|[\s'"`(=:,\[])((?:\/[^\s'"`/)\],;:]+){2,})/g, (whole, lead: string, path: string) =>
      API_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix)) ? whole : `${lead}${path.split('/').pop()}`)
    .replace(/(^|[\s'"`(=:,\[])([A-Za-z]:\\(?:[^\s'"`\\)\],;]+\\)*([^\s'"`\\)\],;]+))/g, (_whole, lead: string, _path: string, last: string) => `${lead}${last}`)
}

/**
 * A parsed JSON document with `withoutServerPaths` applied to every string in it, and whether anything changed. For a
 * JSON file served as it was written (a runner's manifest): a manifest records where its run read and wrote, as
 * absolute paths, and a reader of it needs the names at most. Keys are kept as they are.
 */
export function jsonWithoutServerPaths(value: unknown): { value: unknown; changed: boolean } {
  let changed = false
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const cut = withoutServerPaths(item)
      if (cut !== item) changed = true
      return cut
    }
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, inner]) => [key, walk(inner)]))
    }
    return item
  }
  const out = walk(value)
  return { value: out, changed }
}
