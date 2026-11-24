/**
 * The editor's alignment-check card with two methods on it (WP-15b slice 2), run against a stand-in DOM and real three.js, the way
 * wp-15a-register-proposal-card.test.ts runs the card with one.
 *
 * What this holds: a card that has a photo block shows a block per method with its own proposal, Show and Apply, labelled for the method
 * when both proposed; how far apart the two are is said once, and when it is past the bound the card says that neither is preferred and
 * does not prefer either (no button is styled, ordered, disabled or defaulted differently); Apply by either writes one patch through the
 * editor's own writer with the method in its provenance, moves the scan, and a job is applied once; the preview is of the method asked
 * for; a method whose reference scan has moved is not offered while the other is; the photo method being off, skipped or not needed is
 * said, and "Check with photos" is offered only when the wall match proposed and the photo method was not run.
 *
 * What it does not: that any of it paints. The rules Apply follows are wp-15b2-register-proposal.test.ts and, for the wall match alone,
 * wp-15a-register-proposal-card.test.ts, which this change leaves as it was.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-15b2-*.test.ts
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import type { EditPatch, ScanManifest, WorldJob, WorldProject } from '../../../src/world/types.ts'
import {
  agreementOf,
  multiplyMat4,
  PLACE_REGISTER_PROPOSAL_ARTIFACT,
  type PlaceRegisterResult,
  type RegisterPatchBody,
  type RegistrationProposal,
  type SfmResult,
} from '../../../src/world/register-proposal.ts'

// ── A stand-in for the few DOM calls the card makes ─────────────────────────

class FakeElement {
  className = ''
  textContent = ''
  hidden = false
  disabled = false
  title = ''
  type = ''
  children: FakeElement[] = []
  dataset: Record<string, string> = {}
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<() => void>>()
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  append(...nodes: FakeElement[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: FakeElement[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  click(): void { if (!this.disabled) for (const listener of this.listeners.get('click') ?? []) listener() }
  descendants(): FakeElement[] { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  buttons(): FakeElement[] { return this.descendants().filter((node) => node.tagName === 'button') }
  button(label: string): FakeElement | undefined { return this.buttons().find((node) => node.textContent === label) }
  withText(pattern: RegExp): FakeElement | undefined { return this.descendants().find((node) => pattern.test(node.textContent)) }
  text(): string { return this.descendants().map((node) => node.textContent).join('\n') }
}

const page = new Map<string, FakeElement>()
;(globalThis as unknown as { document: unknown }).document = {
  getElementById: (id: string) => page.get(id) ?? null,
  createElement: (tag: string) => new FakeElement(tag),
}
const section = new FakeElement('div')
section.hidden = true
const list = new FakeElement('div')
page.set('register-proposals-section', section)
page.set('register-proposals', list)

const { mountRegisterProposals } = await import('../../../src/viewer/register-proposal.ts')

// ── A world with a finished check in it ─────────────────────────────────────

const yawTranslation = (yaw: number, tx: number, ty: number, tz: number): number[] => {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1]
}
const IDENTITY = yawTranslation(0, 0, 0, 0)
const MOVING_PLACEMENT = yawTranslation(0.4, 12, 0.02, -3)
const WALL_CORRECTION = yawTranslation(-0.02, 0.18, 0.01, -0.07)
const PHOTO_CORRECTION = yawTranslation(-0.025, 0.2, 0.01, -0.06)
const FAR_CORRECTION = yawTranslation(-0.02, 0.9, 0.01, -0.07)

function walls(overrides: Partial<RegistrationProposal> = {}): RegistrationProposal {
  return {
    status: 'proposed',
    transform: WALL_CORRECTION,
    overlapFraction: 0.91,
    inlierResidualM: 0.031,
    score: 0.86,
    boundedCorrection: { translationM: 0.19, yawDeg: -1.1, dyM: 0.004, maxShiftM: 0.34, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } },
    reason: null,
    details: {
      movingCells: 800, referenceCells: 900, movingMatchedFraction: 0.91, referenceMatchedFraction: 0.8, distinctiveness: 0.95, fit: 0.9,
      peakRatio: 0.2, nearBestReachM: 0.4, verticalChecked: true, searchedTranslationM: 2, searchedYawDeg: 25,
    },
    ...overrides,
  }
}

function photos(overrides: Partial<SfmResult> = {}): SfmResult {
  return {
    status: 'proposed',
    reason: null,
    detail: '',
    reference: { scanId: 'scan-c', filename: '050_c.glb', name: 'Earlier visit', localToWorld: IDENTITY },
    transform: PHOTO_CORRECTION,
    boundedCorrection: { translationM: 0.21, yawDeg: -1.4, dyM: 0.01, maxShiftM: 0.4, withinBound: true, bound: { translationM: 1, yawDeg: 10, dyM: 0.3 } },
    residualM: 0.028,
    registeredFraction: 0.93,
    registeredImages: 13,
    offeredImages: 14,
    inliers: 12,
    scaleRatio: 1,
    tiltDeg: 0.7,
    sessions: [],
    referenceModel: 'built',
    frameId: null,
    params: {},
    elapsedMs: 1000,
    ...overrides,
  }
}

function scan(scanId: string, localToWorld: number[], name: string): ScanManifest {
  return {
    scanId, projectId: 'proj-1', sessionId: null, filename: `${scanId}.glb`, name, glbUrl: '',
    geoPose: { lat: null, lng: null, altitudeM: null, bearing: null, accuracyM: null }, localToWorld, accuracyM: null,
    geoDistanceM: null, capturedAt: null, pointCount: null, detectionCount: null, layerIndex: [], status: 'ready',
  }
}

function jobWith(proposal: RegistrationProposal, sfm: SfmResult | null, jobId = 'job-1'): WorldJob {
  const result: PlaceRegisterResult = {
    proposal,
    moving: { scanId: 'scan-b', filename: 'scan-b.glb', name: 'Second visit', localToWorld: MOVING_PLACEMENT },
    reference: { scanId: 'scan-a', filename: 'scan-a.glb', name: 'First visit', localToWorld: IDENTITY },
    comparisons: [],
    params: {},
    comparedAt: '2026-11-17T10:00:00.000Z',
    elapsedMs: 100,
  }
  if (sfm) result.sfm = sfm
  const agreement = sfm ? agreementOf(proposal.transform, sfm.transform, [14, -2]) : null
  if (agreement) result.agreement = agreement
  return {
    jobId, worldId: 'world-1', type: 'place-register', status: 'completed', scanId: 'scan-b', capabilities: [],
    artifacts: [{ type: PLACE_REGISTER_PROPOSAL_ARTIFACT, label: 'check', metadata: JSON.parse(JSON.stringify(result)) }],
    createdAt: '2026-11-17T10:00:00.000Z', updatedAt: '2026-11-17T10:00:01.000Z',
  }
}

/** The editor: a world, the loaded scan roots, a patch writer that behaves as the server's reply does, and a way to ask for photos. */
function editor(proposal: RegistrationProposal = walls(), sfm: SfmResult | null = photos(), withPhotoCheck = true) {
  const world = {
    worldId: 'world-1',
    scans: [scan('scan-b', MOVING_PLACEMENT, 'Second visit'), scan('scan-a', IDENTITY, 'First visit'), scan('scan-c', IDENTITY, 'Earlier visit')],
    jobs: [jobWith(proposal, sfm)],
    editPatches: [] as EditPatch[],
  } as unknown as WorldProject

  const worldGroup = new THREE.Group()
  const root = new THREE.Group()
  new THREE.Matrix4().fromArray(MOVING_PLACEMENT).decompose(root.position, root.quaternion, root.scale)
  const cloud = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([1, 0, 2, -1, 1, 0.5], 3)))
  root.add(cloud)
  worldGroup.add(root)
  worldGroup.updateMatrixWorld(true)

  const log = { posts: [] as RegisterPatchBody[], moves: [] as Array<{ scanId: string; matrix: number[] }>, asked: [] as string[] }
  const host = {
    world: () => world,
    worldGroup: () => worldGroup,
    scanPoints: (scanId: string) => (scanId === 'scan-b' ? [cloud] : []),
    postPatch: async (body: RegisterPatchBody) => {
      log.posts.push(body)
      world.editPatches.push({
        patchId: `patch-${log.posts.length}`, worldId: world.worldId, scanId: body.scanId, targetId: body.targetId, scope: 'scan',
        transform: body.transform, provenance: body.provenance, createdAt: '2026-11-17T10:05:00.000Z',
      })
      world.scans.find((candidate) => candidate.scanId === body.scanId)!.localToWorld = body.transform.matrix
    },
    moveScan: (scanId: string, matrix: number[]) => log.moves.push({ scanId, matrix }),
    ...(withPhotoCheck
      ? { queuePhotoCheck: async (scanId: string) => void log.asked.push(scanId) }
      : {}),
  }
  const card = mountRegisterProposals(host)
  card.render()
  return { world, worldGroup, cloud, host, card, log }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const ghostGroup = (group: THREE.Group) => group.children.find((child) => child.name === 'alignment check preview') as THREE.Group | undefined

// ── Two methods on one card ─────────────────────────────────────────────────

test('a card with both proposals has a block per method, each with its own Show and Apply labelled for it', () => {
  editor()
  const card = list.children[0]!
  const text = card.text()
  assert.match(text, /Wall match/)
  assert.match(text, /Photo match/)
  assert.match(text, /Compared with First visit\./)
  assert.match(text, /Compared with Earlier visit\./)
  assert.match(text, /13 of 14 photos found their place, camera positions about 3 cm apart\./)
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show wall match', 'Apply wall match', 'Show photo match', 'Apply photo match'])
  assert.doesNotMatch(text, /\b(aligned|verified)\b/i)
  assert.equal(card.buttons().filter((button) => button.textContent === 'Apply').length, 0, 'no unlabelled Apply when there are two')
})

test('the card says once that this is a proposal and what it did not check, and says how far apart the two methods are', () => {
  editor()
  const text = list.children[0]!.text()
  assert.match(text, /A proposal only\. It does not check that these scans are of the same room, or where the Place is on a map\. Nothing moves until you apply it\./)
  assert.equal(text.split('Nothing moves until you apply it.').length - 1, 1, 'said once, not once per method')
  assert.match(text, /The two methods differ by 9 cm and 0\.3°\./)
  assert.doesNotMatch(text, /neither is preferred/)
})

test('two methods that differ by more than the bound are said to, and neither is put forward by anything on the card', () => {
  editor(walls(), photos({ transform: FAR_CORRECTION }))
  const card = list.children[0]!
  const line = card.withText(/The two methods differ by/)!
  assert.match(line.textContent, /That is more than 15 cm, 2° or 5% in size, so neither is preferred\.$/)
  assert.match(line.className, /register-disagree/)
  const applies = card.buttons().filter((button) => button.textContent.startsWith('Apply'))
  const shows = card.buttons().filter((button) => button.textContent.startsWith('Show'))
  assert.equal(applies.length, 2)
  // Same class, both enabled, same hint: the only difference between them is which method they name.
  assert.equal(new Set(applies.map((button) => button.className)).size, 1)
  assert.equal(new Set(shows.map((button) => button.className)).size, 1)
  assert.deepEqual(applies.map((button) => button.disabled), [false, false])
  assert.equal(new Set(applies.map((button) => button.title)).size, 1)
  // Wall match first and photo match second, as when they agree: no order is changed to put one forward.
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show wall match', 'Apply wall match', 'Show photo match', 'Apply photo match'])
})

// ── Apply ───────────────────────────────────────────────────────────────────

test('Apply photo match writes one patch with its own matrix and a provenance that names the method, then the card reads Applied', async () => {
  const { log, worldGroup } = editor()
  list.children[0]!.button('Show photo match')!.click()
  list.children[0]!.button('Apply photo match')!.click()
  await settle()

  assert.equal(log.posts.length, 1)
  assert.deepEqual(log.posts[0]!.provenance, { source: 'place-register', jobId: 'job-1', score: 0.93, residualM: 0.028, method: 'sfm' })
  const expected = multiplyMat4(PHOTO_CORRECTION, MOVING_PLACEMENT)
  assert.deepEqual(log.posts[0]!.transform.matrix, expected)
  assert.deepEqual(log.moves[0]!.matrix, expected, 'the scan on screen goes where the patch puts it')
  assert.equal(ghostGroup(worldGroup), undefined)

  const card = list.children[0]!
  assert.equal(card.buttons().length, 0, 'one job is applied once, by whichever method')
  assert.match(card.text(), /Applied\n/)
  assert.match(card.text(), /Applied to this scan by the photo match at /)
})

test('Apply wall match writes the wall match\'s patch, with no method in it, and the card says which method applied it', async () => {
  const { log } = editor()
  list.children[0]!.button('Apply wall match')!.click()
  await settle()
  assert.equal(log.posts.length, 1)
  assert.deepEqual(log.posts[0]!.provenance, { source: 'place-register', jobId: 'job-1', score: 0.86, residualM: 0.031 })
  assert.deepEqual(log.posts[0]!.transform.matrix, multiplyMat4(WALL_CORRECTION, MOVING_PLACEMENT))
  assert.match(list.children[0]!.text(), /Applied to this scan by the wall match at /)
})

test('Apply that the server refuses says so in the server\'s own words, moves nothing, and both methods are still offered', async () => {
  const { host, log, world } = editor()
  host.postPatch = async () => {
    throw Object.assign(new Error('409 {"error":"This scan has moved since the check. Run it again."}'), { status: 409 })
  }
  list.children[0]!.button('Apply photo match')!.click()
  await settle()
  assert.equal(log.moves.length, 0)
  assert.equal(world.editPatches.length, 0)
  assert.match(list.children[0]!.text(), /Could not apply: This scan has moved since the check\. Run it again\./)
  assert.doesNotMatch(list.children[0]!.text(), /409|\{"error"/)
  assert.ok(list.children[0]!.button('Apply wall match') && list.children[0]!.button('Apply photo match'))
})

// ── The preview ─────────────────────────────────────────────────────────────

test('Show draws the preview of the method asked for, and asking for the other method replaces it', () => {
  const { worldGroup, cloud } = editor()
  list.children[0]!.button('Show photo match')!.click()
  const group = ghostGroup(worldGroup)!
  worldGroup.updateMatrixWorld(true)
  const [, after] = group.children as THREE.Points[]
  const local = new THREE.Vector3(1, 0, 2)
  const now = local.clone().applyMatrix4(cloud.matrixWorld)
  const photoExpected = now.clone().applyMatrix4(new THREE.Matrix4().fromArray(PHOTO_CORRECTION))
  assert.ok(local.clone().applyMatrix4(after!.matrixWorld).distanceTo(photoExpected) < 1e-9, 'the photo match\'s correction')
  // The button says what it will do, and the other method's still says Show.
  assert.ok(list.children[0]!.button('Hide photo match'))
  assert.ok(list.children[0]!.button('Show wall match'))

  list.children[0]!.button('Show wall match')!.click()
  assert.equal(worldGroup.children.filter((child) => child.name === 'alignment check preview').length, 1, 'one preview at a time')
  const second = ghostGroup(worldGroup)!
  worldGroup.updateMatrixWorld(true)
  const wallExpected = now.clone().applyMatrix4(new THREE.Matrix4().fromArray(WALL_CORRECTION))
  assert.ok(local.clone().applyMatrix4((second.children[1] as THREE.Points).matrixWorld).distanceTo(wallExpected) < 1e-9, 'now the wall match\'s')
  assert.ok(list.children[0]!.button('Hide wall match') && list.children[0]!.button('Show photo match'))

  list.children[0]!.button('Hide wall match')!.click()
  assert.equal(ghostGroup(worldGroup), undefined)
})

// ── When only one method proposed, or the photo method did not run ──────────

test('with only the photo method proposing, its block has the plain Show and Apply, and the wall block says why it has none', async () => {
  const { log } = editor(walls({ status: 'refused', transform: null, reason: 'ambiguous', score: 0.2 }), photos())
  const card = list.children[0]!
  assert.match(card.text(), /Wall match\nNo move proposed\nThe walls do not settle one position\./)
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show', 'Apply'])
  assert.equal(card.withText(/The two methods differ/), undefined, 'one method, nothing to compare')
  card.button('Apply')!.click()
  await settle()
  assert.equal(log.posts[0]!.provenance.method, 'sfm', 'the one Apply is the photo method\'s')
})

test('with only the wall match proposing and the photo method refused, the photo block says why and the wall match keeps its buttons', () => {
  editor(walls(), photos({ status: 'refused', reason: 'collinear', transform: null, residualM: null, registeredFraction: null }))
  const card = list.children[0]!
  assert.match(card.text(), /Photo match\nNo move proposed\nThe camera positions lie on a line, which cannot fix the turn\./)
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show', 'Apply'])
})

test('a photo method that is off says so on the card and the wall match is the card it was', () => {
  editor(walls(), photos({ status: 'skipped', reason: 'off', transform: null, reference: null }))
  const card = list.children[0]!
  assert.match(card.text(), /Photo match\nPhoto matching is turned off on this server\./)
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show', 'Apply'])
  assert.equal(card.button('Check with photos'), undefined, 'there is nothing to ask for when it is off')
})

test('every other reason the photo method did not run is said, in its own words', () => {
  for (const [reason, pattern] of [
    ['colmap-missing', /Photo matching needs COLMAP, and this server has none\./],
    ['no-keyframes', /This scan has no camera photos on the server\./],
    ['no-reference', /No other calibrated scan in this Place has camera photos\./],
    ['frame-mismatch', /calibrated against different versions of the Place reference\./],
    ['no-overlap', /none of this scan's photos looks at the same place/],
  ] as const) {
    editor(walls(), photos({ status: 'skipped', reason, transform: null, reference: null }))
    assert.match(list.children[0]!.text(), pattern, reason)
  }
})

test('when the wall match proposed and the photo method was not run, a person may ask for it, and the card says what happened', async () => {
  const { log } = editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }))
  const card = list.children[0]!
  assert.equal(card.withText(/Photo match/), undefined, 'no block for a method nobody needed')
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show', 'Apply', 'Check with photos'])
  card.button('Check with photos')!.click()
  assert.match(list.children[0]!.text(), /Asking for a check with photos\.\.\./)
  assert.equal(list.children[0]!.button('Check with photos')!.disabled, true)
  await settle()
  assert.deepEqual(log.asked, ['scan-b'])
  assert.match(list.children[0]!.text(), /Asked\. The new check appears here when it is done\./)
})

test('a request for photos that the server refuses says so in its words, and can be tried again', async () => {
  const { host, log } = editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }))
  let refuse = true
  host.queuePhotoCheck = async (scanId: string) => {
    if (refuse) {
      refuse = false
      throw new Error('503 try later')
    }
    log.asked.push(scanId)
  }
  list.children[0]!.button('Check with photos')!.click()
  await settle()
  assert.match(list.children[0]!.text(), /Could not ask: 503 try later/)
  list.children[0]!.button('Check with photos')!.click()
  await settle()
  assert.deepEqual(log.asked, ['scan-b'])
})

test('a request for photos that the server answers with a check already waiting or running says it will not use the photos, and not that it asked', async () => {
  // The server hands a request for a scan that already has an alignment check queued back that check, whose payload does not ask for photos.
  const answers: Array<{ payload?: Record<string, unknown> } | void> = [
    { payload: { source: 'joined-place', referenceScanIds: ['scan-a'] } },
    {},
    { payload: { method: 'sfm', source: 'viewer' } },
    undefined,
  ]
  const wording: string[] = []
  for (const answer of answers) {
    const { host } = editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }))
    host.queuePhotoCheck = async () => answer
    list.children[0]!.button('Check with photos')!.click()
    await settle()
    wording.push(list.children[0]!.text().match(/(This scan already has a check waiting or running[^\n]*|Asked\.[^\n]*)/)?.[0] ?? '(neither)')
  }
  const waiting = 'This scan already has a check waiting or running, which will not use the photos. Ask again when it is done.'
  const asked = 'Asked. The new check appears here when it is done.'
  assert.deepEqual(wording, [waiting, waiting, asked, asked])
})

test('a host that cannot queue jobs offers no such button, and a card applied already offers none either', async () => {
  editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }), false)
  assert.equal(list.children[0]!.button('Check with photos'), undefined)
  const { log } = editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }))
  list.children[0]!.button('Apply')!.click()
  await settle()
  assert.equal(log.posts.length, 1)
  assert.equal(list.children[0]!.button('Check with photos'), undefined, 'a scan that has been moved is checked again from where it now is, not from here')
})

test('a record from before the photo method is the single-method card, with no block titles, and says what the check did not look at', () => {
  editor(walls(), null)
  const card = list.children[0]!
  assert.doesNotMatch(card.text(), /Wall match|Photo match|Check with photos/)
  assert.deepEqual(card.buttons().map((button) => button.textContent), ['Show', 'Apply'])
  const text = card.text()
  assert.match(text, /A proposal only\. It does not check that these scans are of the same room, or where the Place is on a map\. Nothing moves until you apply it\./)
  assert.equal(text.split('Nothing moves until you apply it.').length - 1, 1, 'said once, with the note')
  assert.match(card.withText(/A proposal only/)!.className, /register-caveat/)
})

test('the card a scan gets when the wall match proposed and nobody asked for photos says what was not checked, once', () => {
  editor(walls(), photos({ status: 'skipped', reason: 'not-needed', transform: null, reference: null }))
  const text = list.children[0]!.text()
  assert.match(text, /A proposal only\. It does not check that these scans are of the same room, or where the Place is on a map\./)
  assert.equal(text.split('Nothing moves until you apply it.').length - 1, 1)
  assert.match(text, /Proposed move/)
})

test('a single-method card with no move says what was not looked at, and not that it is a proposal', () => {
  editor(walls({ status: 'refused', transform: null, reason: 'ambiguous', boundedCorrection: null }), null)
  const text = list.children[0]!.text()
  assert.match(text, /No move proposed/)
  assert.match(text, /It does not check that these scans are of the same room, or where the Place is on a map\./)
  assert.doesNotMatch(text, /A proposal only|Nothing moves until/)
})

// ── Stale ───────────────────────────────────────────────────────────────────

test('a photo method whose reference scan has moved is not offered, while the wall match measured against another scan still is', () => {
  const { world, card } = editor()
  world.scans.find((candidate) => candidate.scanId === 'scan-c')!.localToWorld = yawTranslation(0, 1, 0, 0)
  card.render()
  const text = list.children[0]!.text()
  assert.deepEqual(list.children[0]!.buttons().map((button) => button.textContent), ['Show wall match', 'Apply wall match'], 'only the wall match is left, still named for its method')
  assert.match(text, /has moved since the check\. Run the check again\./)
})
