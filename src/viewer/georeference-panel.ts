/**
 * The Place location and heading panel in the editor: latitude, longitude and heading as numbers, the accuracy each claims, "Use
 * compass estimate from N scans", and Save or Confirm through `PUT /projects/:id/georeference`.
 *
 * The markup is in viewer.html (`#georeference-section`); this file is the events and the requests, and every decision and every
 * sentence is in ./georeference-form.ts, where a test can reach it. The map registration editor (WP-13) will write the same record
 * through the same client (src/world/georef-client.ts); this is the same by numbers, so the whole pipeline works before it.
 *
 * It writes text with `textContent` only: nothing a server or a person typed reaches `innerHTML`.
 */
import {
  adoptGeoreferenceOutcome,
  fetchGeoreferenceSeed,
  fetchPlaceRecord,
  GEOREFERENCE_CONFLICT_TEXT,
  saveGeoreference,
  savedVersionOf,
} from '../world/georef-client.ts'
import { isConfirmedGeoreference } from '../world/georef.ts'
import type { Project } from '../world/types.ts'
import {
  applyEstimate,
  buildFromForm,
  claimText,
  CONFIRM_LABEL,
  CONFIRMED_MESSAGE,
  EARLIER_FRAME_TEXT,
  estimateText,
  type FormState,
  type FormValues,
  isEarlierFrame,
  NO_ESTIMATE_LABEL,
  OLD_SCANS_TEXT,
  REPLACES_CONFIRMED_TEXT,
  SAVE_APPROXIMATE_LABEL,
  SAVED_APPROXIMATE_MESSAGE,
  savedStatusText,
  startingValues,
  useEstimateLabel,
  valuesFromRecord,
} from './georeference-form.ts'

/** What the panel needs from the editor. */
export interface LocationPanelHost {
  /** The Place being edited, or null when the world has none (the legacy default world). */
  projectId: () => string | null
  /** Whether the world is an older one whose GPS placements are mirrored: the panel says what a location does to its scans. */
  worldIsMirrored: () => boolean
  /** Called after a location was saved: the editor reloads the world, which the server has placed again. */
  worldChanged: () => void
}

export interface LocationPanel {
  /**
   * The editor's own refresh (every time it redraws the world): reads the Place and the compass estimate again and fills the form,
   * unless the person has typed since it was filled or a save is on its way, when it changes nothing. It never clears a message.
   */
  refresh: () => Promise<void>
  /** Opens the panel, brings its tab forward and puts the cursor in the first field. */
  open: () => void
}

const FIELDS: Array<[keyof FormValues, string]> = [
  ['lat', 'georef-lat'],
  ['lng', 'georef-lng'],
  ['heading', 'georef-heading'],
  ['originAccuracyM', 'georef-origin-accuracy'],
  ['headingAccuracyDeg', 'georef-heading-accuracy'],
]

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/** Mounts the panel on the markup in viewer.html. Null when the page has none (a page that is not the editor). */
export function mountLocationPanel(host: LocationPanelHost): LocationPanel | null {
  const section = byId<HTMLDetailsElement>('georeference-section')
  if (!section) return null
  const inputs = Object.fromEntries(FIELDS.map(([key, id]) => [key, byId<HTMLInputElement>(id)])) as Record<keyof FormValues, HTMLInputElement | null>
  const status = byId('georef-status')
  const claim = byId('georef-claim')
  const estimateButton = byId<HTMLButtonElement>('georef-estimate')
  const estimateNote = byId('georef-estimate-note')
  const saveButton = byId<HTMLButtonElement>('georef-save')
  const confirmButton = byId<HTMLButtonElement>('georef-confirm')
  const message = byId('georef-message')
  const earlierFrame = byId('georef-earlier-frame')
  const replacesConfirmed = byId('georef-replaces-confirmed')
  const oldScans = byId('georef-old-scans')
  if (!status || !claim || !estimateButton || !estimateNote || !saveButton || !confirmButton || !message || !earlierFrame || !replacesConfirmed || !oldScans) return null

  let place: Project | null = null
  let state: FormState = { values: startingValues(), seed: null }
  /** A save, or the read that opens the panel, is on its way. The fields wait, so nothing is typed against a record that has not been read. */
  let busy = false
  /**
   * True from the first edit, or the first fill from the compass estimate, until the next save or the next time the panel is opened:
   * a draft. The editor redraws the world whenever a scan arrives or a job finishes, and a redraw that read the Place again would
   * put the saved numbers over what a person was typing, and name a newer version than the one the draft began from, so it leaves a
   * draft alone.
   */
  let dirty = false
  /** Counts the reads, so that only the latest one is applied. */
  let reads = 0
  /** Set by `open`: the cursor goes to the first field once the read that the opening starts has filled it. */
  let focusWhenRead = false

  const say = (text: string, tone: 'plain' | 'error' = 'plain') => {
    message.textContent = text
    message.dataset['tone'] = tone
  }

  /** Writes the state into the fields and the lines that follow from it. */
  const render = () => {
    for (const [key] of FIELDS) {
      const input = inputs[key]
      if (input && input.value !== state.values[key]) input.value = state.values[key]
    }
    claim.textContent = claimText(state)
    status.textContent = savedStatusText(place?.georeference)
    earlierFrame.textContent = place && isEarlierFrame(place) ? EARLIER_FRAME_TEXT : ''
    earlierFrame.hidden = earlierFrame.textContent === ''
    const fromEstimate = state.seed !== null
    replacesConfirmed.textContent = fromEstimate && isConfirmedGeoreference(place?.georeference) ? REPLACES_CONFIRMED_TEXT : ''
    replacesConfirmed.hidden = replacesConfirmed.textContent === ''
    oldScans.textContent = host.worldIsMirrored() ? OLD_SCANS_TEXT : ''
    oldScans.hidden = oldScans.textContent === ''
    const lines = estimateText(state.seed?.reply ?? null)
    estimateNote.textContent = lines.join(' ')
    estimateNote.hidden = lines.length === 0
    const hasPlace = place !== null
    for (const input of Object.values(inputs)) if (input) input.disabled = !hasPlace || busy
    saveButton.disabled = !hasPlace || busy
    confirmButton.disabled = !hasPlace || busy
  }

  let estimate: Awaited<ReturnType<typeof fetchGeoreferenceSeed>> = null
  const renderEstimateButton = () => {
    const used = estimate?.bearing ? estimate.bearing.scans : 0
    estimateButton.textContent = used > 0 ? useEstimateLabel(used) : NO_ESTIMATE_LABEL
    estimateButton.disabled = used === 0 || place === null || busy
  }

  /**
   * Reads the Place and the compass estimate and fills the form. `opened` is true when the person has just opened the panel: a fresh
   * start, so the last draft and the last message go. The editor's own refreshes (`opened` false) leave a draft and a message alone,
   * and say nothing when the read fails: the form still holds the last good one.
   */
  const reload = async (opened: boolean) => {
    if (!opened && (dirty || busy)) return
    const mine = ++reads
    if (opened) {
      dirty = false
      busy = true
      render()
      renderEstimateButton()
    }
    const projectId = host.projectId()
    const [record, seedReply] = projectId
      ? await Promise.all([fetchPlaceRecord(projectId), fetchGeoreferenceSeed(projectId)])
      : [null, null]
    // A newer read supersedes this one, and a draft that was started while this was in flight must keep the version it began from.
    if (mine !== reads || (!opened && (dirty || busy))) return
    if (opened) busy = false
    if (record) {
      place = record
      estimate = seedReply
      state = { values: record.georeference ? valuesFromRecord(record.georeference) : startingValues(), seed: null }
    } else if (opened) {
      place = null
      estimate = null
    }
    render()
    renderEstimateButton()
    if (opened) {
      if (!projectId) say('Choose a Place to set its location.')
      else if (!record) say('This Place could not be read. Check the connection and try again.', 'error')
      else say('')
      if (focusWhenRead && record) inputs.lat?.focus()
      focusWhenRead = false
    }
  }

  const save = async (confirmed: boolean) => {
    const projectId = host.projectId()
    if (!projectId || !place || busy) return
    const built = buildFromForm(state, place, new Date(), confirmed)
    if (!built.ok) {
      say(`Check the numbers. ${built.reasons.join(' ')}`, 'error')
      return
    }
    busy = true
    // A read that is still in flight began before this save, and would put the record from before it back.
    reads += 1
    render()
    renderEstimateButton()
    say('Saving...')
    const outcome = await saveGeoreference(projectId, built.georeference, savedVersionOf(place))
    busy = false
    if (outcome.status === 'saved') {
      adoptGeoreferenceOutcome(place, outcome)
      dirty = false
      state = { values: valuesFromRecord(outcome.georeference), seed: null }
      render()
      renderEstimateButton()
      say(confirmed ? CONFIRMED_MESSAGE : SAVED_APPROXIMATE_MESSAGE)
      host.worldChanged()
      return
    }
    if (outcome.status === 'conflict') {
      adoptGeoreferenceOutcome(place, outcome)
      dirty = false
      state = { values: outcome.current.georeference ? valuesFromRecord(outcome.current.georeference) : startingValues(), seed: null }
      render()
      renderEstimateButton()
      say(GEOREFERENCE_CONFLICT_TEXT, 'error')
      return
    }
    render()
    renderEstimateButton()
    if (outcome.status === 'invalid') say(`The server did not accept these numbers. ${outcome.reasons.join(' ')}`, 'error')
    else say(outcome.reason, 'error')
  }

  render()
  renderEstimateButton()
  for (const [key] of FIELDS) {
    inputs[key]?.addEventListener('input', () => {
      dirty = true
      state = { ...state, values: { ...state.values, [key]: inputs[key]!.value } }
      claim.textContent = claimText(state)
      replacesConfirmed.hidden = !(state.seed !== null && isConfirmedGeoreference(place?.georeference))
    })
  }
  estimateButton.addEventListener('click', () => {
    if (!estimate) return
    const next = applyEstimate(state.values, estimate)
    if (!next) return
    dirty = true
    state = next
    render()
    say('Filled from the compass estimate. Nothing is saved until you save.')
  })
  saveButton.textContent = SAVE_APPROXIMATE_LABEL
  confirmButton.textContent = CONFIRM_LABEL
  saveButton.addEventListener('click', () => void save(false))
  confirmButton.addEventListener('click', () => void save(true))
  section.addEventListener('toggle', () => {
    if (section.open) void reload(true)
  })

  return {
    // The panel reads the Place when it opens, so a read while it is closed has nothing to fill.
    refresh: () => (section.open ? reload(false) : Promise.resolve()),
    open: () => {
      byId<HTMLButtonElement>('tab-btn-world')?.click()
      const wasOpen = section.open
      section.open = true
      section.scrollIntoView?.({ block: 'nearest' })
      // Opening fires `toggle`, which reads the Place and then moves the cursor. A panel that is already open holds what it read, and
      // a draft with it: it is only brought forward.
      if (wasOpen) inputs.lat?.focus()
      else focusWhenRead = true
    },
  }
}
