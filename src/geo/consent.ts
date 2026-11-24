/**
 * A device's answer to "may this app send something of yours to that host?", kept in localStorage as JSON
 * `{ "host": string, "allowed": boolean }`: one answer for one host under one key. The basemap's question
 * ("show map tiles from this host?", ./basemap-layer.ts) was the first; the reverse geocoder's ("look up the street
 * address there?", ./geocode-consent.ts) is the second, under its own key (wave 14, ticket 0004; F-08). An answer
 * belongs to the host it named: a different host is asked again.
 *
 * Nothing here throws: unreadable or blocked storage reads as no answer, and a save that storage refuses is lost
 * (a private window), so a caller keeps the answer for the page itself.
 */

/** What an answer needs of localStorage. */
export interface ConsentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A device's answer for one host. */
export interface ConsentAnswer {
  host: string
  allowed: boolean
}

/** The answer saved under `key`, or null when there is none, it is unreadable, or storage is blocked. */
export function readConsent(storage: ConsentStorage | null, key: string): ConsentAnswer | null {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return null
    const saved = JSON.parse(raw) as { host?: unknown; allowed?: unknown } | null
    return typeof saved?.host === 'string' && typeof saved.allowed === 'boolean' ? { host: saved.host, allowed: saved.allowed } : null
  } catch {
    return null
  }
}

/** Saves the answer under `key`. Blocked storage (a private window) loses it: the page keeps it until it closes. */
export function writeConsent(storage: ConsentStorage | null, key: string, answer: ConsentAnswer): void {
  try {
    storage?.setItem(key, JSON.stringify(answer))
  } catch { /* blocked or full */ }
}

/** localStorage, or null where reading it throws (blocked storage) or there is none (a test, a worker). */
export function browserConsentStorage(): ConsentStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}
