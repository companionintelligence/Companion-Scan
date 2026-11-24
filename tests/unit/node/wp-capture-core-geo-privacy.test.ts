/**
 * Wave 14, ticket 0004 (F-08, client side; FN-048, FN-049, FN-050): what leaves the device about where it is.
 *
 *  - The reverse geocoder is asked nothing until this device has said yes, once (src/geo/geocode-consent.ts, in the
 *    basemap's pattern through src/geo/consent.ts). A no is kept and never asked again.
 *  - GeoTracker.stop() takes its orientation listeners off the window, and a later start() puts them back.
 *  - The session summary's altitude row claims no datum, and its upload never sends a client-local `local-` id.
 *
 * Positions and addresses here are placeholders, not anywhere in particular. Nothing reaches a network or a sensor.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-capture-core-geo-privacy.test.ts
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeoTracker, type GeoFix } from '../../../src/geo/geo-tracker.ts'
import {
  GEOCODER_HOST,
  GEOCODE_CONSENT_CARD_ID,
  GEOCODE_CONSENT_NO,
  GEOCODE_CONSENT_YES,
  askOnPage,
  pageGeocodeConsent,
  saveGeocodeAnswer,
  savedGeocodeAnswer,
  type GeocodeConsent,
} from '../../../src/geo/geocode-consent.ts'
import { readConsent, type ConsentStorage } from '../../../src/geo/consent.ts'
import { BASEMAP_CONSENT_KEY, GEOCODE_CONSENT_KEY } from '../../../src/shared/storage-keys.ts'
import { readAnswer, writeAnswer } from '../../../src/geo/basemap-layer.ts'
import { altitudeCell, summaryUploadForm } from '../../../src/export/summary.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

// ── Stand-ins ────────────────────────────────────────────────────────────────

/** A placeholder position: not a real place. */
const PLACE = { lat: 10.000001, lng: 20.000001 }
const ANSWER = { display_name: 'Example Road, Example Town', address: { road: 'Example Road', city: 'Example Town' } }

interface Tracker {
  snapshot(): GeoFix | null
  _applyPosition(pos: { coords: { latitude: number; longitude: number; accuracy: number; altitude: number | null }; timestamp: number }): GeoFix
  _geocode(fix: GeoFix): Promise<void>
}

function at(lng = PLACE.lng) {
  return { coords: { latitude: PLACE.lat, longitude: lng, accuracy: 5, altitude: null }, timestamp: 1_700_000_000_000 }
}

/** Records every request instead of making it. */
function requests(t: TestContext): string[] {
  const sent: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    sent.push(String(input))
    return new Response(JSON.stringify(ANSWER), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return sent
}

/** A consent whose question the test answers. */
function consent(saved: boolean | null, answer: () => Promise<boolean>): GeocodeConsent & { asked: number } {
  const c = {
    asked: 0,
    answer: () => saved,
    ask: async () => {
      c.asked += 1
      return answer()
    },
  }
  return c
}

function memoryStorage(initial: Record<string, string> = {}): ConsentStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

// ── The geocoder asks first ─────────────────────────────────────────────────

test('not asked yet: the person is asked once, and a no sends nothing, now or for any later fix', async (t) => {
  const sent = requests(t)
  const c = consent(null, async () => false)
  const geo = new GeoTracker({ geocodeConsent: c }) as unknown as Tracker
  await Promise.all([
    geo._geocode(geo._applyPosition(at())),
    geo._geocode(geo._applyPosition(at(PLACE.lng + 0.00001))),
  ])
  await geo._geocode(geo._applyPosition(at(PLACE.lng + 0.01)))
  assert.equal(c.asked, 1, 'one question, however many fixes')
  assert.deepEqual(sent, [])
  assert.equal(geo.snapshot()?.address, null, 'the scan keeps its coordinates and has no address')
})

test('a yes to the question looks the address up, once per cell, at the geocoder named on the card', async (t) => {
  const sent = requests(t)
  const c = consent(null, async () => true)
  const geo = new GeoTracker({ geocodeConsent: c }) as unknown as Tracker
  await Promise.all([
    geo._geocode(geo._applyPosition(at())),
    geo._geocode(geo._applyPosition(at(PLACE.lng + 0.00001))),
  ])
  assert.equal(c.asked, 1)
  assert.equal(sent.length, 1, 'the two fixes are one cell: one request')
  assert.equal(new URL(sent[0]!).host, GEOCODER_HOST)
  assert.equal(geo.snapshot()?.address, 'Example Road, Example Town')
})

test('a saved answer is not asked again: a yes goes straight to the request, a no never sends', async (t) => {
  const sent = requests(t)
  const yes = consent(true, async () => true)
  const geo = new GeoTracker({ geocodeConsent: yes }) as unknown as Tracker
  const pending = geo._geocode(geo._applyPosition(at()))
  assert.equal(sent.length, 1, 'with a known yes, nothing is awaited before the request')
  await pending
  assert.equal(yes.asked, 0)

  const no = consent(false, async () => true)
  const geo2 = new GeoTracker({ geocodeConsent: no }) as unknown as Tracker
  await geo2._geocode(geo2._applyPosition(at(PLACE.lng + 0.01)))
  assert.equal(no.asked, 0)
  assert.equal(sent.length, 1)
})

test('a question that fails is a no for the page, and is not asked again on it', async (t) => {
  const sent = requests(t)
  const broken = consent(null, async () => { throw new Error('no page') })
  const geo = new GeoTracker({ geocodeConsent: broken }) as unknown as Tracker
  await geo._geocode(geo._applyPosition(at()))
  await geo._geocode(geo._applyPosition(at(PLACE.lng + 0.01)))
  assert.equal(broken.asked, 1)
  assert.deepEqual(sent, [])
})

test('with no stand-in and no page to ask on, the default sends nothing', async (t) => {
  const sent = requests(t)
  const geo = new GeoTracker() as unknown as Tracker
  await geo._geocode(geo._applyPosition(at()))
  assert.deepEqual(sent, [])
})

// ── The card, and the answer it keeps ───────────────────────────────────────

class FakeElement {
  id = ''
  textContent: string | null = null
  style = { cssText: '' }
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  parent: FakeElement | null = null
  listeners = new Map<string, Array<() => void>>()
  readonly tag: string
  constructor(tag: string) {
    this.tag = tag
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(type: string, fn: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) }
  append(...nodes: FakeElement[]): void { for (const n of nodes) this.appendChild(n) }
  appendChild(node: FakeElement): FakeElement { node.parent = this; this.children.push(node); return node }
  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((c) => c !== this)
    this.parent = null
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn() }
  text(): string { return [this.textContent ?? '', ...this.children.map((c) => c.text())].join(' ') }
  find(predicate: (e: FakeElement) => boolean): FakeElement | null {
    if (predicate(this)) return this
    for (const c of this.children) {
      const hit = c.find(predicate)
      if (hit) return hit
    }
    return null
  }
}

function fakeDocument() {
  const body = new FakeElement('body')
  return {
    body,
    createElement: (tag: string) => new FakeElement(tag) as unknown as HTMLElement,
    getElementById: (id: string) => body.find((e) => e.id === id),
  }
}

const cardOf = (doc: ReturnType<typeof fakeDocument>) => doc.body.find((e) => e.id === GEOCODE_CONSENT_CARD_ID)
const buttonOf = (doc: ReturnType<typeof fakeDocument>, label: string) => doc.body.find((e) => e.tag === 'button' && e.textContent === label)

test('the card names the host and what a no keeps; a yes is saved for that host and the card goes', async () => {
  const doc = fakeDocument()
  const storage = memoryStorage()
  const page = pageGeocodeConsent({ storage, document: doc })
  assert.equal(page.answer(GEOCODER_HOST), null)
  const asked = page.ask(GEOCODER_HOST)
  const card = cardOf(doc)
  assert.ok(card, 'the question is on the page')
  assert.equal(card.attributes.get('role'), 'dialog')
  assert.match(card.text(), new RegExp(GEOCODER_HOST.replace(/\./g, '\\.')))
  assert.match(card.text(), /outside this app/)
  assert.match(card.text(), /keeps its coordinates and has no address/)
  assert.match(card.style.cssText, /position:fixed/)
  assert.ok(Number(/z-index:(\d+)/.exec(card.style.cssText)?.[1]) > 900, 'above every layer the scanner draws, the start screen included')
  buttonOf(doc, GEOCODE_CONSENT_YES)!.click()
  assert.equal(await asked, true)
  assert.equal(cardOf(doc), null)
  assert.deepEqual(readConsent(storage, GEOCODE_CONSENT_KEY), { host: GEOCODER_HOST, allowed: true })
  assert.equal(page.answer(GEOCODER_HOST), true)
  assert.equal(page.answer('another.example'), null, 'an answer belongs to the host it named')
})

test('a no is saved too, and a second question while the card is up waits for the same answer', async () => {
  const doc = fakeDocument()
  const storage = memoryStorage()
  const page = pageGeocodeConsent({ storage, document: doc })
  const first = page.ask(GEOCODER_HOST)
  const second = askOnPage(doc as never, GEOCODER_HOST)
  assert.equal(doc.body.children.length, 1, 'one card')
  buttonOf(doc, GEOCODE_CONSENT_NO)!.click()
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal(savedGeocodeAnswer(storage), false)
})

test('no page to ask on answers no and saves nothing; blocked storage reads as not asked', async () => {
  const storage = memoryStorage()
  const page = pageGeocodeConsent({ storage, document: null })
  assert.equal(await page.ask(GEOCODER_HOST), false)
  assert.equal(storage.data.size, 0)
  const blocked: ConsentStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(savedGeocodeAnswer(blocked), null)
  saveGeocodeAnswer(blocked, GEOCODER_HOST, true) // does not throw
})

test('the geocoder\'s answer and the basemap\'s live under their own keys, in one shape', () => {
  const storage = memoryStorage()
  writeAnswer(storage, { host: 'tiles.example', allowed: true })
  saveGeocodeAnswer(storage, GEOCODER_HOST, false)
  assert.deepEqual(readAnswer(storage), { host: 'tiles.example', allowed: true })
  assert.deepEqual(readConsent(storage, BASEMAP_CONSENT_KEY), { host: 'tiles.example', allowed: true })
  assert.equal(savedGeocodeAnswer(storage), false)
  assert.notEqual(GEOCODE_CONSENT_KEY, BASEMAP_CONSENT_KEY)
  assert.equal(GEOCODE_CONSENT_KEY, 'companion-scan-geocode-consent')
})

// ── stop() ───────────────────────────────────────────────────────────────────

test('stop() takes both orientation listeners off the window, and a later start() puts them back (FN-050)', async (t) => {
  const listening = new Map<string, Set<unknown>>()
  const stub = (name: string, value: unknown): void => {
    const had = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    t.after(() => {
      if (had) Object.defineProperty(globalThis, name, had)
      else delete (globalThis as Record<string, unknown>)[name]
    })
  }
  stub('window', {
    addEventListener: (type: string, fn: unknown) => { listening.set(type, new Set([...(listening.get(type) ?? []), fn])) },
    removeEventListener: (type: string, fn: unknown) => { listening.get(type)?.delete(fn) },
  })
  stub('sessionStorage', { getItem: () => null, setItem: () => {} })
  let cleared = 0
  stub('navigator', { geolocation: { watchPosition: (_ok: unknown, fail: (e: { message: string }) => void) => { fail({ message: 'none' }); return 7 }, clearWatch: () => { cleared += 1 } } })
  t.mock.method(console, 'warn', () => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const geo = new GeoTracker({ geocodeConsent: consent(false, async () => false) })
  await geo.start()
  assert.equal(listening.get('deviceorientation')?.size, 1)
  assert.equal(listening.get('deviceorientationabsolute')?.size, 1)
  geo.stop()
  assert.equal(cleared, 1)
  assert.equal(listening.get('deviceorientation')?.size, 0, 'nothing reads the sensor for a stopped tracker')
  assert.equal(listening.get('deviceorientationabsolute')?.size, 0)
  await geo.start()
  assert.equal(listening.get('deviceorientation')?.size, 1, 'a restart has a compass again')
  assert.equal(listening.get('deviceorientationabsolute')?.size, 1)
})

// ── The summary ──────────────────────────────────────────────────────────────

test('the altitude row says the datum is not known, instead of "above sea level"', () => {
  const cell = altitudeCell(41.6)
  assert.match(cell, /^42 m, datum unknown/)
  assert.doesNotMatch(cell, /ASL/)
  assert.doesNotMatch(read('src/export/summary.ts'), /m ASL/)
})

test('the summary upload sends the session id only when the server minted it, and always sends the file', async () => {
  const local = summaryUploadForm('# s', 'scan-summary.md', 'local-0f9e8d7c-6b5a-4321-8765-0123456789ab')
  assert.equal(local.has('sessionId'), false, 'a client-local id names no server session')
  assert.equal((local.get('file') as File).name, 'scan-summary.md')
  assert.equal(await (local.get('file') as File).text(), '# s')
  const minted = summaryUploadForm('# s', 'scan-summary.md', 'sess-0f9e8d7c-6b5a-4321-8765-0123456789ab')
  assert.equal(minted.get('sessionId'), 'sess-0f9e8d7c-6b5a-4321-8765-0123456789ab')
  for (const none of [undefined, null, '', 'session-1787174216556']) {
    assert.equal(summaryUploadForm('# s', 'f.md', none).has('sessionId'), false, String(none))
  }
  assert.match(read('src/export/summary.ts'), /const form = summaryUploadForm\(content, filename, store\.sessionId\)/)
})
