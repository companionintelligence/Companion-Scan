/**
 * The reverse geocoder's question (wave 14, ticket 0004; F-08). GeoTracker (./geo-tracker.ts) turns a GPS fix into a
 * street address by sending the position, to six decimal places, to OpenStreetMap's public address lookup: a third
 * party, not the Scan server. Before this, it sent on every new fix with no question and no disclosure. Now nothing is
 * sent until the person has said yes, once per device, in the basemap's pattern (./basemap-layer.ts): one question,
 * one answer for one host, kept in localStorage (GEOCODE_CONSENT_KEY, through ./consent.ts), and a host that changes is
 * asked about again.
 *
 * No answer means no request. A no is kept and never asked again on this device; the scan keeps its coordinates and has
 * no address. Blocked storage (a private window) cannot keep an answer, so the tracker holds it for the page.
 *
 * The question is a small card this module draws itself, with inline styles, as the basemap draws its status box: the
 * pages that start a GeoTracker (src/main.ts) are another session's files. It sits fixed at the top of the window above
 * every layer the scanner draws (their highest is the basemap's 900), so it shows over the start screen as well as over
 * the AR view. The top, because the bottom is where the scanner's own controls are: the Scan cards, the capture button,
 * the calibration card, the re-anchor banner and the drift check. Needs a device run: that the card is readable and
 * reachable there has not been seen on a phone.
 */
import { GEOCODE_CONSENT_KEY } from '../shared/storage-keys.ts'
import { browserConsentStorage, readConsent, writeConsent, type ConsentStorage } from './consent.ts'

/** The host GeoTracker's address lookups go to. */
export const GEOCODER_HOST = 'nominatim.openstreetmap.org'

/** The card's element id, so a second ask on the same page finds the card that is already up. */
export const GEOCODE_CONSENT_CARD_ID = 'geocode-consent'

/** The words on the card. Its question, what the yes sends and to whom, and what a no keeps. */
export const GEOCODE_CONSENT_TITLE = 'Look up the street address?'
export function geocodeConsentText(host: string): string {
  return `To name the street, your position goes to ${host}, OpenStreetMap's address lookup, outside this app. Without it, the scan keeps its coordinates and has no address.`
}
export const GEOCODE_CONSENT_YES = 'Look it up'
export const GEOCODE_CONSENT_NO = 'No address'
export const GEOCODE_CONSENT_NOTE = 'Asked once on this device.'

/** What GeoTracker asks before a lookup. */
export interface GeocodeConsent {
  /** This device's answer for `host`: true for a yes, false for a no, null when it has not been asked. */
  answer(host: string): boolean | null
  /** Asks the person, saves the answer, and resolves with it. */
  ask(host: string): Promise<boolean>
}

/** This device's saved answer for `host`, or null when there is none for that host. */
export function savedGeocodeAnswer(storage: ConsentStorage | null, host: string = GEOCODER_HOST): boolean | null {
  const answer = readConsent(storage, GEOCODE_CONSENT_KEY)
  return answer && answer.host === host ? answer.allowed : null
}

/** Saves an answer for `host`. A page that offers to change one (a setting) writes it through here. */
export function saveGeocodeAnswer(storage: ConsentStorage | null, host: string, allowed: boolean): void {
  writeConsent(storage, GEOCODE_CONSENT_KEY, { host, allowed })
}

const FONT = 'font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif'
const CARD = `position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top, 0px));transform:translateX(-50%);z-index:950;width:min(340px,calc(100% - 32px));box-sizing:border-box;padding:12px 14px;border-radius:10px;${FONT};color:#fff;background:rgba(8,28,38,0.96);border:1px solid rgba(114,221,212,0.4);`
const BUTTON = 'margin:8px 8px 0 0;min-height:44px;padding:0 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.08);color:#fff;font:inherit;font-weight:700;cursor:pointer;'

/** The part of a document the card needs. */
export interface CardDocument {
  getElementById(id: string): unknown
  createElement(tag: string): HTMLElement
  body: { appendChild(node: HTMLElement): unknown } | null
}

/**
 * Shows the card on `doc` and resolves with the person's answer, removing the card. Resolves false at once where there
 * is no page to ask on. While a card is up, a second ask on the same document waits for the same answer.
 */
export function askOnPage(doc: CardDocument | null | undefined, host: string): Promise<boolean> {
  if (!doc?.body) return Promise.resolve(false)
  const pending = pendingAsks.get(doc)
  if (pending) return pending
  const asked = new Promise<boolean>((resolve) => {
    const card = doc.createElement('div')
    card.id = GEOCODE_CONSENT_CARD_ID
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-labelledby', `${GEOCODE_CONSENT_CARD_ID}-title`)
    card.style.cssText = CARD
    const title = doc.createElement('div')
    title.id = `${GEOCODE_CONSENT_CARD_ID}-title`
    title.style.cssText = 'font-weight:700;margin-bottom:4px;'
    title.textContent = GEOCODE_CONSENT_TITLE
    const text = doc.createElement('div')
    text.textContent = geocodeConsentText(host)
    const note = doc.createElement('div')
    note.style.cssText = 'margin-top:6px;color:rgba(239,240,240,0.7);font-size:12px;'
    note.textContent = GEOCODE_CONSENT_NOTE
    const choose = (allowed: boolean): void => {
      card.remove()
      pendingAsks.delete(doc)
      resolve(allowed)
    }
    const yes = doc.createElement('button')
    yes.setAttribute('type', 'button')
    yes.style.cssText = BUTTON
    yes.textContent = GEOCODE_CONSENT_YES
    yes.addEventListener('click', () => choose(true))
    const no = doc.createElement('button')
    no.setAttribute('type', 'button')
    no.style.cssText = BUTTON
    no.textContent = GEOCODE_CONSENT_NO
    no.addEventListener('click', () => choose(false))
    card.append(title, text, yes, no, note)
    doc.body!.appendChild(card)
  })
  pendingAsks.set(doc, asked)
  return asked
}

const pendingAsks = new WeakMap<object, Promise<boolean>>()

/** The page's own: localStorage for the answer and a card on this document for the question. */
export function pageGeocodeConsent(
  deps: { storage?: ConsentStorage | null; document?: CardDocument | null } = {},
): GeocodeConsent {
  const storage = deps.storage !== undefined ? deps.storage : browserConsentStorage()
  const doc = deps.document !== undefined ? deps.document : (globalThis as { document?: CardDocument }).document ?? null
  return {
    answer: (host) => savedGeocodeAnswer(storage, host),
    ask: async (host) => {
      const allowed = await askOnPage(doc, host)
      // No page to ask on is no answer, not a no: nothing is saved, and a page that can ask will.
      if (doc?.body) saveGeocodeAnswer(storage, host, allowed)
      return allowed
    },
  }
}
