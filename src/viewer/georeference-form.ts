/**
 * The Place location and heading panel's logic: what a person's numbers become, what the record claims about them, and the words that
 * say so. Pure, and kept out of the panel's DOM code (./georeference-panel.ts), so every claim can be tested without a browser.
 * Same style as ./scan-calibration-chip.ts and src/ar/alignment-status.ts: short plain words, and nothing the data does not hold
 * (ADR 0005 rule 3). The decision is docs/adr/0015-scene-convention-and-georeference.md.
 *
 * ## What a person can do here
 *
 * Type a latitude, a longitude and a heading, or ask for the compass estimate of the Place's scans, and save. That is all the map
 * registration editor (WP-13) will do with a picture: this is the same record by numbers, so the whole pipeline works before it.
 *
 * ## Honesty
 *
 *  - **Approximate until confirmed.** "Save as approximate" stores a record with no `confirmedAt`; only "Confirm location and
 *    heading" sets it. A compass estimate is never stored as confirmed by being an estimate, and filling the form from it changes
 *    nothing on the server until a person saves.
 *  - **The accuracy is shown, and it has a floor.** Numbers typed by hand cannot claim better than a map click can (3.5 m, 1 degree:
 *    `ACCURACY_FLOORS.typed`), and a record made unedited from the compass estimate is a compass seed (10 m, 15 degrees at the best, 25 on an
 *    iPhone). The form states the claim it will make, in words, before it is saved, and refuses a number under the floor.
 *  - **A seed is not averaged into a confirmation.** The estimate fills the form; it does not touch a confirmed record until the
 *    person saves over it, and the form says that is what a save would do.
 *  - **Saving the numbers as they are changes only what the button says.** A record the person saves again without changing its
 *    latitude, longitude or heading keeps its source and what it rested on (a compass seed stays a seed, with the declination and
 *    scans it used; a map click stays a map click); the two buttons decide only whether it is confirmed. The accuracy the person
 *    types is held to the floor of that source, so lowering only the accuracy of a saved compass seed does not make it a typed
 *    number that claims what a map click can: the numbers still came from the phone's compass, and nothing checked them.
 *  - **Nothing is guessed.** A field that is empty or is not a number is not filled in; the form says which.
 *
 * The compass estimate says what it rests on: how many scans, and that indoors a compass can be tens of degrees out.
 */
import {
  ACCURACY_FLOORS,
  buildGeoreference,
  georeferenceFrameState,
  isConfirmedGeoreference,
  ORIGIN_ACCURACY_FLOOR_IMAGERY_M,
  validateGeoreference,
} from '../world/georef.ts'
import type { GeoreferenceSeedReply } from '../world/georef-client.ts'
import type { GeoreferenceSource, Project, ProjectGeoreference } from '../world/types.ts'
import { aboutMetres } from './placement-note.ts'

// ─── Adopted constants (ADR 0005 rule 5) ─────────────────────────────────────

/**
 * The heading accuracy the form starts typed numbers at, degrees. The floor for typed numbers is 1 degree (a long building edge), but
 * a person typing a heading rarely read it off one, and a default of 1 would claim what nobody checked. 5 degrees is what an
 * ordinary two-click bearing from 10 to 20 m gives at the research's click noise. **Adopted, not measured** (DX7): lower it when
 * the heading came from a long wall or edge.
 */
export const TYPED_HEADING_ACCURACY_DEFAULT_DEG = 5

// ─── The words ───────────────────────────────────────────────────────────────

export const PANEL_TITLE = 'Place location and heading'
export const PANEL_HINT = 'Where this Place is on the map, and which way it faces.'
export const LATITUDE_LABEL = 'Latitude'
export const LONGITUDE_LABEL = 'Longitude'
export const HEADING_LABEL = 'Heading, degrees from true north'
export const HEADING_HELP = "Which way the Place's forward axis points: from its first marker toward its second."
export const LOCATION_ACCURACY_LABEL = 'Location accuracy, metres'
export const HEADING_ACCURACY_LABEL = 'Heading accuracy, degrees'
export const SAVE_APPROXIMATE_LABEL = 'Save as approximate'
export const CONFIRM_LABEL = 'Confirm location and heading'
export const NO_ESTIMATE_LABEL = 'No scans have a compass estimate yet'
export const NO_LOCATION_TEXT = 'No location saved yet.'
export const SAVED_APPROXIMATE_TEXT = 'Saved: approximate, not confirmed.'
export const EARLIER_FRAME_TEXT = 'This location was set for an earlier alignment of this Place.'
export const COMPASS_CAVEAT = 'Approximate. Indoors a compass can be off by tens of degrees.'
export const REPLACES_CONFIRMED_TEXT = 'Saving this replaces the confirmed location with an estimate.'
export const OLD_SCANS_TEXT = 'Scans from before this update have no compass record of their session, so they stand on the grid until you move them.'
/** What a save says once the server has it. A scan a person moved by hand does not move, so the words do not say every scan was placed. */
export const SAVED_APPROXIMATE_MESSAGE = 'Saved as approximate. Scans you have not moved by hand follow it.'
export const CONFIRMED_MESSAGE = 'Confirmed. Scans you have not moved by hand follow it.'

/** "Use compass estimate from 3 scans". */
export function useEstimateLabel(scans: number): string {
  return `Use compass estimate from ${scans} scan${scans === 1 ? '' : 's'}`
}

/** What a saved record says about itself, in one line. */
export function savedStatusText(record: ProjectGeoreference | null | undefined): string {
  if (!record) return NO_LOCATION_TEXT
  if (isConfirmedGeoreference(record)) {
    const when = new Date(record.confirmedAt!)
    return Number.isNaN(when.getTime()) ? 'Saved and confirmed.' : `Saved and confirmed ${when.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
  }
  return SAVED_APPROXIMATE_TEXT
}

// ─── The form ────────────────────────────────────────────────────────────────

/** What the fields hold, as text: a number that is half typed is not a number yet. */
export interface FormValues {
  lat: string
  lng: string
  heading: string
  originAccuracyM: string
  headingAccuracyDeg: string
}

export type FormSource = 'typed' | 'gps-compass'

/** The compass estimate the form was filled from, with the values it put in the fields so an edit can be told from an untouched one. */
export interface FormSeed {
  reply: GeoreferenceSeedReply
  filled: FormValues
}

export interface FormState {
  values: FormValues
  seed: FormSeed | null
}

export const EMPTY_VALUES: FormValues = { lat: '', lng: '', heading: '', originAccuracyM: '', headingAccuracyDeg: '' }

/** A number from what a person typed: a comma as a decimal point, a minus sign of any kind, spaces ignored. Null when it is not one. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(/[−–—]/g, '-').replace(/\s+/g, '')
  if (trimmed === '') return null
  const normalised = /^-?\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(normalised)) return null
  const n = Number(normalised)
  return Number.isFinite(n) ? n : null
}

/** A number as a field holds it: enough digits for a millimetre, no trailing zeros. */
function shownNumber(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)))
}

/** The values of the record a Place holds, as the form shows them. Empty for a Place with none. */
export function valuesFromRecord(record: ProjectGeoreference | null | undefined): FormValues {
  if (!record) return { ...EMPTY_VALUES }
  return {
    lat: shownNumber(record.origin.lat, 9),
    lng: shownNumber(record.origin.lng, 9),
    heading: shownNumber(record.bearingDeg, 3),
    originAccuracyM: shownNumber(record.origin.accuracyM, 2),
    headingAccuracyDeg: shownNumber(record.bearingAccuracyDeg, 2),
  }
}

/**
 * What the compass estimate puts in the form. The heading and its accuracy, always; the location and its accuracy when the scans gave a
 * landmark position. Fields the estimate has no value for keep what the person had. Null when the estimate has no bearing.
 */
export function applyEstimate(current: FormValues, reply: GeoreferenceSeedReply): FormState | null {
  if (!reply.bearing) return null
  const values: FormValues = {
    ...current,
    heading: shownNumber(reply.bearing.deg, 1),
    headingAccuracyDeg: shownNumber(reply.bearing.sigmaDeg, 1),
  }
  if (reply.origin) {
    values.lat = shownNumber(reply.origin.lat, 9)
    values.lng = shownNumber(reply.origin.lng, 9)
    values.originAccuracyM = shownNumber(reply.origin.accuracyM, 1)
  }
  return { values, seed: { reply, filled: { ...values } } }
}

/** The values the form starts from when the Place has no record: the accuracies typed numbers may claim, and nothing else. */
export function startingValues(): FormValues {
  return {
    ...EMPTY_VALUES,
    originAccuracyM: shownNumber(ORIGIN_ACCURACY_FLOOR_IMAGERY_M, 1),
    headingAccuracyDeg: shownNumber(TYPED_HEADING_ACCURACY_DEFAULT_DEG, 1),
  }
}

/**
 * Where the numbers came from: `'gps-compass'` only when the form was filled from the compass estimate and the latitude, longitude and
 * heading are still what it put there (the person has changed none of them), `'typed'` otherwise. An edited estimate is the person's
 * numbers, and claims what typed numbers can.
 */
export function sourceOf(state: FormState): FormSource {
  const seed = state.seed
  if (!seed || !seed.reply.origin || !seed.reply.bearing) return 'typed'
  const same = (a: keyof FormValues) => state.values[a] === seed.filled[a]
  return same('lat') && same('lng') && same('heading') ? 'gps-compass' : 'typed'
}

export type FormResult =
  | { ok: true; georeference: ProjectGeoreference; source: GeoreferenceSource }
  | { ok: false; reasons: string[] }

/** What a re-save keeps of the record it replaces: see {@link carriedFrom}. */
export interface Carried {
  /** The saved height, when the latitude and longitude are the saved ones. */
  altitudeM: number | null
  /** What the saved record was made from (its source, the declination it used, the scans it rested on), when every number is still the saved one. Null otherwise. */
  provenance: Pick<ProjectGeoreference, 'source' | 'declination' | 'seed'> | null
}

/**
 * What saving again keeps of the saved record, so that saving numbers again does not unmake what they were:
 *
 *  - **The height**, when the latitude and longitude are the saved ones. It belongs to that spot, and this panel has no field for it, so
 *    a save would otherwise drop what the map registration editor (or a survey) recorded.
 *  - **The provenance**, when the latitude, longitude and heading are still the saved ones: Confirm on an unedited compass seed
 *    confirms a seed, which the phone's GPS and compass still made; Save on an unedited map click is still a map click. The accuracy
 *    fields are not part of that test, because they are the claim and not the numbers: a person who lowers only the accuracy of a
 *    seed has not measured anything, and the record keeps the source whose floor that claim must clear. A latitude, longitude or
 *    heading the person changed is theirs, and the record says `typed`.
 */
export function carriedFrom(saved: ProjectGeoreference | null | undefined, values: FormValues): Carried {
  if (!saved) return { altitudeM: null, provenance: null }
  const kept = valuesFromRecord(saved)
  const same = (keys: Array<keyof FormValues>) => keys.every((key) => values[key] === kept[key])
  const sameNumbers = same(['lat', 'lng', 'heading'])
  return {
    altitudeM: same(['lat', 'lng']) ? saved.origin.altitudeM : null,
    provenance: sameNumbers
      ? { source: saved.source, ...(saved.declination ? { declination: saved.declination } : {}), ...(saved.seed ? { seed: saved.seed } : {}) }
      : null,
  }
}

/**
 * The record the form's numbers make, or why they cannot be one. `confirmed` is whether the person pressed Confirm: only then does
 * the record carry `confirmedAt`. The record is the one `validateGeoreference` takes, and what it refuses is said in the person's words
 * (a field that is empty, a latitude out of range) before the server's reasons are needed.
 */
export function buildFromForm(state: FormState, project: Pick<Project, 'spatialFrame' | 'georeference'> | null, now: Date, confirmed: boolean): FormResult {
  const reasons: string[] = []
  const number = (field: keyof FormValues, name: string): number | null => {
    const parsed = parseNumber(state.values[field])
    if (parsed === null) reasons.push(state.values[field].trim() === '' ? `${name} is empty.` : `${name} is not a number.`)
    return parsed
  }
  const lat = number('lat', LATITUDE_LABEL)
  const lng = number('lng', LONGITUDE_LABEL)
  const heading = number('heading', 'Heading')
  const originAccuracyM = number('originAccuracyM', 'Location accuracy')
  const headingAccuracyDeg = number('headingAccuracyDeg', 'Heading accuracy')
  if (lat !== null && (lat < -89.999 || lat > 89.999)) reasons.push('Latitude must be from -90 to 90.')
  if (lng !== null && (lng < -180 || lng > 180)) reasons.push('Longitude must be from -180 to 180.')
  if (heading !== null && Math.abs(heading) > 360) reasons.push('Heading must be from -360 to 360 degrees.')
  // A fresh estimate in the form is the person's to save as it stands; numbers that are still the saved record's keep what it was (see `carriedFrom`).
  const carried = carriedFrom(project?.georeference, state.values)
  const kept = state.seed ? null : carried.provenance
  const source: GeoreferenceSource = kept ? kept.source : sourceOf(state)
  const floor = ACCURACY_FLOORS[source]
  if (originAccuracyM !== null && originAccuracyM < floor.originM) {
    reasons.push(`Location accuracy cannot be better than ${Number(floor.originM.toPrecision(3))} m${source === 'typed' ? ': a map click is no better than that' : ''}.`)
  }
  if (headingAccuracyDeg !== null && headingAccuracyDeg < floor.bearingDeg) {
    reasons.push(`Heading accuracy cannot be better than ${Number(floor.bearingDeg.toPrecision(3))} degrees${source === 'typed' ? ': a long building edge gives about that' : ''}.`)
  }
  if (reasons.length > 0 || lat === null || lng === null || heading === null || originAccuracyM === null || headingAccuracyDeg === null) {
    return { ok: false, reasons: reasons.length > 0 ? reasons : ['Fill in every field.'] }
  }

  const frame = project?.spatialFrame as { frameId?: unknown } | undefined
  const reply = state.seed?.reply
  const georeference = buildGeoreference({
    lat,
    lng,
    altitudeM: carried.altitudeM,
    originAccuracyM,
    bearingDeg: heading,
    bearingAccuracyDeg: headingAccuracyDeg,
    source,
    ...(source === 'gps-compass' && reply?.declination ? { declination: reply.declination } : {}),
    ...(state.seed && reply?.bearing
      ? {
        seed: {
          scans: reply.bearing.scans,
          spreadDeg: Number(reply.bearing.spreadDeg.toFixed(2)),
          lowConfidence: reply.bearing.lowConfidence,
          fromSeed: source === 'gps-compass',
        },
      }
      : {}),
    ...(kept?.declination ? { declination: kept.declination } : {}),
    ...(kept?.seed ? { seed: kept.seed } : {}),
    anchorRef: typeof frame?.frameId === 'string' ? frame.frameId : null,
    now,
    confirmed,
  })
  const check = validateGeoreference(georeference, { now: now.getTime() })
  if (!check.ok) return { ok: false, reasons: check.errors }
  return { ok: true, georeference: check.georeference, source }
}

/** What the form is about to claim, in words, from its current numbers: shown beside the fields, so no record is a surprise. */
export function claimText(state: FormState): string {
  const origin = parseNumber(state.values.originAccuracyM)
  const heading = parseNumber(state.values.headingAccuracyDeg)
  const about = origin === null ? null : aboutMetres(origin)
  const parts = [
    about === null ? 'Location accuracy not set' : `Location approximate to ${about}`,
    heading === null || heading <= 0 ? 'heading accuracy not set' : `heading about ${Number(heading.toPrecision(2))} degrees`,
  ]
  return parts.join(' · ')
}

/** The lines under the estimate button: what it rests on, and how little that is. */
export function estimateText(reply: GeoreferenceSeedReply | null): string[] {
  if (!reply?.bearing) return []
  const lines = [COMPASS_CAVEAT]
  const { scans, lowConfidence, spreadDeg } = reply.bearing
  lines.push(
    lowConfidence
      ? `Only ${scans} scan${scans === 1 ? '' : 's'}, or readings that disagree by about ${Math.round(spreadDeg)} degrees: a rough guess.`
      : `${scans} scans agree to about ${Math.round(spreadDeg)} degrees.`,
  )
  if (!reply.origin) lines.push('No scan recorded where the camera was at its GPS fix, so type the location.')
  return lines
}

/** Whether the saved record was made for an earlier alignment of the Place. */
export function isEarlierFrame(project: Pick<Project, 'spatialFrame' | 'georeference'> | null): boolean {
  return georeferenceFrameState(project?.georeference, project?.spatialFrame as { frameId?: unknown } | undefined) === 'other-frame'
}
