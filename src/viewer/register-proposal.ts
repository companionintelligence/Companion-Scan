/**
 * The editor's side of the `place-register` job: show what it measured, preview
 * the move it proposes, and let a person apply it. Nothing here moves a scan on
 * its own.
 *
 * Each scan with a finished alignment check gets a card in the World tab:
 *
 *  - what was compared and what lined up, in the words `describeRegisterResult`
 *    chooses, which say what was measured and never "aligned" or "verified";
 *  - **Show**, which draws the scan's points twice over the scene: where the scan
 *    sits now in red, and where the proposal would put it in green;
 *  - **Apply**, which writes an ordinary scan EditPatch carrying
 *    `provenance { source: 'place-register', jobId, score, residualM }` through
 *    the same `postEditPatch` the Edit gizmo uses. The raw `sessionToProject` in
 *    the scan's sidecar is not touched; the patch is the refined placement and
 *    the provenance carries the residual that backs it.
 *
 * When the photo method has run (or has something to say, such as that it is off) the card has two sections, "Wall match" and
 * "Photo match", each with its own proposal, its own Show and its own Apply, and a line for how far apart the two put the scan.
 * Neither is put forward: when they differ by more than the bound the line says that neither is preferred, and both buttons stay
 * the same. A person applies one, once (one job is applied at most once, whichever method), and what the patch records is which.
 * A card for a record with no photo block, which is every record an earlier build wrote, is the single-method card it always was.
 *
 * Every rule about when Apply may run, what it writes and what a second press
 * does lives in src/world/register-proposal.ts (`applyRegistrationProposal`), which
 * has no DOM and is tested under Node. This file only draws and wires.
 *
 * The ghosts share each scan's point geometry and own only their materials, so
 * removing one frees nothing the scan still needs.
 */
import * as THREE from 'three'
import type { WorldProject } from '../world/types.ts'
import { plainServerError } from './transform-tools.ts'
import {
  applyRegistrationProposal,
  buildRegisterPatch,
  describeAgreement,
  describeRegisterResult,
  describeSfmResult,
  findAppliedRegisterPatch,
  methodProposal,
  notCheckedText,
  NOTHING_MOVES_LINE,
  type PlaceRegisterResult,
  proposedMethods,
  readPlaceRegisterResult,
  type RegisterPatchBody,
  registerApplyState,
  type RegistrationMethod,
  requestsPhotoMethod,
} from '../world/register-proposal.ts'

/** What the card needs from the editor. Injected so this file does not reach into viewer.ts's state. */
export interface RegisterProposalHost {
  world(): WorldProject | null
  /** Writes the patch as every other editor save does, and updates the editor's world from the reply. Rejects on a refusal. */
  postPatch(body: RegisterPatchBody): Promise<void>
  /** The group every scan root hangs from, or null before a Place has loaded. */
  worldGroup(): THREE.Group | null
  /** The point clouds of a scan that is loaded in the scene; empty when it is not. */
  scanPoints(scanId: string): THREE.Points[]
  /** Puts a loaded scan's root at `matrix`, column-major, as the editor does when it loads a scan with patches. */
  moveScan(scanId: string, matrix: number[]): void
  /**
   * Asks the server for another check of the scan that also uses its camera photos (a `place-register` job with `payload.method`
   * `'sfm'`). Optional: a host that cannot queue jobs shows no such button. Rejects when the server refuses.
   */
  queuePhotoCheck?(scanId: string): Promise<{ payload?: Record<string, unknown> } | void>
}

export interface RegisterProposals {
  /** Redraws the cards from the editor's current world. Cheap; called whenever the job list is. */
  render(): void
}

/** Where the scan sits now. */
const BEFORE_COLOUR = 0xff6b6b
/** Where the proposal would put it. */
const AFTER_COLOUR = 0x5be0a3
/** The newest scans with a check, so a Place with many scans does not fill the tab. */
const MAX_CARDS = 5

interface Ghost {
  jobId: string
  method: RegistrationMethod
  worldId: string
  group: THREE.Group
  materials: THREE.Material[]
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * What went wrong, in the server's own words when it gave some. `postEditPatch` reports a refusal as
 * `<status> <body>`; the sentence a person can act on is the `error` inside that body, not the JSON around it. The one
 * reader of that sentence is `plainServerError` (./transform-tools.ts, FN-085); without one, the message as it came.
 */
function errorText(error: unknown): string {
  return plainServerError(error, error instanceof Error ? error.message : String(error))
}

export function mountRegisterProposals(host: RegisterProposalHost): RegisterProposals {
  const section = document.getElementById('register-proposals-section')
  const list = document.getElementById('register-proposals')
  let ghost: Ghost | null = null
  /** What each card says besides the check itself: that Apply is under way, or why the last try failed. Kept across redraws. */
  const notes = new Map<string, string>()
  const busy = new Set<string>()

  function clearGhost(): void {
    if (!ghost) return
    ghost.group.parent?.remove(ghost.group)
    for (const material of ghost.materials) material.dispose()
    ghost = null
  }

  function showGhost(jobId: string, result: PlaceRegisterResult, world: WorldProject, method: RegistrationMethod): boolean {
    clearGhost()
    const parent = host.worldGroup()
    const transform = methodProposal(result, method)?.transform
    if (!parent || !transform) return false
    const sources = host.scanPoints(result.moving.scanId)
    if (sources.length === 0) return false

    const group = new THREE.Group()
    group.name = 'alignment check preview'
    const correction = new THREE.Matrix4().fromArray(transform)
    const parentInverse = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    const materials: THREE.Material[] = []
    for (const [colour, moved] of [[BEFORE_COLOUR, false], [AFTER_COLOUR, true]] as const) {
      const material = new THREE.PointsMaterial({
        color: colour,
        size: 0.05,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
      materials.push(material)
      for (const source of sources) {
        source.updateWorldMatrix(true, false)
        const copy = new THREE.Points(source.geometry, material)
        copy.matrixAutoUpdate = false
        copy.matrix.copy(parentInverse).multiply(source.matrixWorld)
        // The correction is in the Place frame, which is the frame the scan roots live in.
        if (moved) copy.matrix.premultiply(correction)
        copy.renderOrder = 3
        group.add(copy)
      }
    }
    parent.add(group)
    ghost = { jobId, method, worldId: world.worldId, group, materials }
    return true
  }

  /** The words a button carries when two methods share a card: which method it is for. */
  const METHOD_WORDS: Record<RegistrationMethod, string> = { 'scan-match': 'wall match', 'sfm': 'photo match' }

  /**
   * One method's Show and Apply. `labelled` is true when two methods share the card, and the buttons then say which they are for; a
   * card with one proposal keeps the plain words it always had.
   */
  function actionsFor(
    jobId: string,
    result: PlaceRegisterResult,
    world: WorldProject,
    method: RegistrationMethod,
    labelled: boolean,
  ): HTMLElement {
    const suffix = labelled ? ` ${METHOD_WORDS[method]}` : ''
    const showing = ghost?.jobId === jobId && ghost.method === method
    const actions = element('div', 'register-actions')
    const show = element('button', 'job-btn', `${showing ? 'Hide' : 'Show'}${suffix}`)
    show.type = 'button'
    show.addEventListener('click', () => {
      if (ghost?.jobId === jobId && ghost.method === method) clearGhost()
      else if (!showGhost(jobId, result, world, method)) notes.set(jobId, 'Open this scan in the scene first, then show the preview.')
      else notes.delete(jobId)
      render()
    })
    const apply = element('button', 'job-btn', `Apply${suffix}`)
    apply.type = 'button'
    apply.disabled = busy.has(jobId)
    apply.title = 'Moves this scan as shown. The original calibration is kept.'
    apply.addEventListener('click', () => {
      // A press on a card whose first press is still travelling changes nothing: it must not clear the note or
      // re-enable the button that the first press is waiting behind.
      if (busy.has(jobId)) return
      busy.add(jobId)
      notes.set(jobId, 'Applying...')
      render()
      void applyRegistrationProposal(result, jobId, {
        scans: () => host.world()?.scans ?? [],
        patches: () => host.world()?.editPatches ?? [],
        post: (body) => host.postPatch(body),
      }, method).then((outcome) => {
        if (outcome === 'applied') {
          const body = buildRegisterPatch(result, jobId, method)
          if (body) host.moveScan(result.moving.scanId, body.transform.matrix)
          clearGhost()
          notes.delete(jobId)
        } else if (outcome === 'already-applied') {
          notes.delete(jobId)
        } else if (outcome === 'stale') {
          notes.set(jobId, 'This scan has moved since the check. Run the check again.')
        } else {
          notes.set(jobId, 'This check proposed no move.')
        }
      }).catch((error: unknown) => {
        notes.set(jobId, `Could not apply: ${errorText(error)}`)
      }).finally(() => {
        busy.delete(jobId)
        render()
      })
    })
    actions.append(show, apply)
    return actions
  }

  /** A titled block of one method's headline and lines, with its buttons when it has a move that can be applied now. */
  function methodBlock(title: string | null, headline: string | null, lines: string[], actions: HTMLElement | null): HTMLElement {
    const block = element('div', 'register-method')
    if (title) block.append(element('div', 'layer-meta register-method-title', title))
    if (headline) block.append(element('div', 'register-headline', headline))
    for (const line of lines) block.append(element('div', 'layer-meta', line))
    if (actions) block.append(actions)
    return block
  }

  function card(jobId: string, result: PlaceRegisterResult, world: WorldProject): HTMLElement {
    const scans = world.scans
    const patches = world.editPatches ?? []
    const applied = findAppliedRegisterPatch(patches, jobId)
    const states = new Map(
      (['scan-match', 'sfm'] as const).map((method) => [method, registerApplyState(result, jobId, scans, patches, method)] as const),
    )
    const wall = describeRegisterResult(result)
    const photo = describeSfmResult(result)
    // The photo method gets a section of its own when it ran or has something to say. A skip because the wall match proposed and nobody
    // asked is not something to say: the card offers the check instead.
    const photoShown = photo !== null && !(result.sfm?.status === 'skipped' && result.sfm.reason === 'not-needed')
    const labelled = proposedMethods(result).length === 2

    const root = element('div', 'register-card')
    root.dataset['jobId'] = jobId
    root.append(element('div', 'job-title register-title', result.moving.name || result.moving.filename))

    if (!photoShown) {
      // The card as it was before the photo method: one headline, its lines, Show and Apply.
      root.append(element('div', 'register-headline', states.get('scan-match') === 'applied' ? 'Applied' : wall.headline))
      // The caveat ends with the line that nothing moves until Apply, so the card says it once.
      for (const line of wall.lines.filter((line) => line !== NOTHING_MOVES_LINE)) root.append(element('div', 'layer-meta', line))
      root.append(element('div', 'layer-meta register-caveat', notCheckedText(result)))
    } else {
      if (applied) root.append(element('div', 'register-headline', 'Applied'))
      const ready = (method: RegistrationMethod) => states.get(method) === 'ready'
      root.append(methodBlock(
        'Wall match',
        wall.headline,
        wall.lines.filter((line) => line !== NOTHING_MOVES_LINE),
        ready('scan-match') ? actionsFor(jobId, result, world, 'scan-match', labelled) : null,
      ))
      root.append(methodBlock(
        'Photo match',
        photo!.headline,
        photo!.lines.filter((line) => line !== NOTHING_MOVES_LINE),
        ready('sfm') ? actionsFor(jobId, result, world, 'sfm', labelled) : null,
      ))
      const agreement = describeAgreement(result)
      if (agreement) root.append(element('div', agreement.withinBound ? 'layer-meta register-agreement' : 'layer-meta register-agreement register-disagree', agreement.text))
      // What no part of this card checked, once, for both methods: they are proposals, and neither looks at which room it is.
      root.append(element('div', 'layer-meta register-caveat', notCheckedText(result)))
    }

    const note = element('div', 'layer-meta register-note')
    note.setAttribute('role', 'status')
    const remembered = notes.get(jobId)
    if (applied) {
      // Whatever the card said while it was applying is over: the patch is in the world, which is what "applied" means.
      const by = photoShown ? ` by the ${applied.provenance?.method === 'sfm' ? METHOD_WORDS.sfm : METHOD_WORDS['scan-match']}` : ''
      note.textContent = `Applied to this scan${by}${applied ? ` at ${new Date(applied.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''}.`
    } else if ([...states.values()].includes('stale')) {
      note.textContent = 'This scan, or the one it was checked against, has moved since the check. Run the check again.'
    } else if (remembered) {
      note.textContent = remembered
    }

    // The single-method card keeps its buttons under its text, as it always had them.
    if (!photoShown && states.get('scan-match') === 'ready') root.append(actionsFor(jobId, result, world, 'scan-match', false))

    // When the wall match proposed and the photo method was not run, a person may ask for it.
    if (!applied && result.sfm?.status === 'skipped' && result.sfm.reason === 'not-needed' && host.queuePhotoCheck) {
      const ask = element('button', 'job-btn', 'Check with photos')
      ask.type = 'button'
      ask.disabled = busy.has(jobId)
      ask.title = 'Also compares this scan\'s camera photos with the earlier scan\'s, which takes longer.'
      ask.addEventListener('click', () => {
        if (busy.has(jobId)) return
        busy.add(jobId)
        notes.set(jobId, 'Asking for a check with photos...')
        render()
        void host.queuePhotoCheck!(result.moving.scanId).then((queued) => {
          // A scan that already has a check waiting or running is answered with that job, and its payload does not ask for photos.
          notes.set(jobId, queued && !requestsPhotoMethod(queued.payload)
            ? 'This scan already has a check waiting or running, which will not use the photos. Ask again when it is done.'
            : 'Asked. The new check appears here when it is done.')
        }).catch((error: unknown) => {
          notes.set(jobId, `Could not ask: ${errorText(error)}`)
        }).finally(() => {
          busy.delete(jobId)
          render()
        })
      })
      const actions = element('div', 'register-actions')
      actions.append(ask)
      root.append(actions)
    }
    root.append(note)
    return root
  }

  function render(): void {
    if (!section || !list) return
    const world = host.world()
    if (!world) {
      clearGhost()
      section.hidden = true
      return
    }
    // A preview belongs to the Place it was drawn for.
    if (ghost && ghost.worldId !== world.worldId) clearGhost()

    // The newest readable check for each scan. Jobs are newest first.
    const seen = new Set<string>()
    const cards: Array<{ jobId: string; result: PlaceRegisterResult }> = []
    for (const job of world.jobs) {
      if (job.type !== 'place-register' || !job.scanId || seen.has(job.scanId)) continue
      const result = readPlaceRegisterResult(job)
      if (!result) continue
      seen.add(job.scanId)
      cards.push({ jobId: job.jobId, result })
      if (cards.length >= MAX_CARDS) break
    }
    if (ghost && !cards.some((entry) => entry.jobId === ghost!.jobId)) clearGhost()

    list.replaceChildren(...cards.map(({ jobId, result }) => card(jobId, result, world)))
    section.hidden = cards.length === 0
  }

  return { render }
}
