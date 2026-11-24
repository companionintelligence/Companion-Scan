/// <reference lib="dom" />
/// <reference lib="deno.ns" />
/**
 * The rules both editors share (src/viewer/world-rules.ts, F-41, FN-083), and the editor pieces that moved out of
 * viewer.html and into code: the drawer layout (src/viewer/editor-layout.ts, FN-064) and the desktop app's scanner
 * entry (src/viewer/desktop-nav.ts, FN-019). Also the 4D layer's request path (src/viewer/splat4d-layer.ts), whose
 * manifest now carries the editor's token like every other request (F-10).
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0'
import * as THREE from 'three'
import {
  applyLocalToWorld,
  fetchOptimizationManifest,
  fullScanGlbPath,
  optimizationManifestPath,
  previewScanGlb,
  worldSlugFrom,
  type OptimizationManifest,
} from '../../../src/viewer/world-rules.ts'
import { worldSlugFrom as headsetSlug } from '../../../src/viewer/xr-world-model.ts'
import { addAccessToken } from '../../../src/shared/access-token.ts'
import { DESKTOP_SCAN_ENTRY, relabelScanEntryForDesktop } from '../../../src/viewer/desktop-nav.ts'
import { fetchPerson4DManifest } from '../../../src/viewer/splat4d-layer.ts'

Deno.test('worldSlugFrom: ?world=, else the Place world for ?project=, else default, and the headset reads the same rule', () => {
  assertEquals(worldSlugFrom('?world=house&project=p1'), 'house')
  assertEquals(worldSlugFrom('?project=p1'), 'project-p1')
  assertEquals(worldSlugFrom(''), 'default')
  assert(headsetSlug === worldSlugFrom, 'one function, re-exported for the headset editor')
})

const MANIFEST: OptimizationManifest = {
  artifacts: {
    optimized: { filename: 'room.opt.glb', bytes: 100, draco: true, quantized: true },
    lods: [{ filename: 'room.lod0.glb', bytes: 10, points: 1000, voxelM: 0.05 }],
  },
}

Deno.test('the GLB lookup: the optimized artifact when there is one, the preview LOD, else the scan GLB', () => {
  const scan = { glbUrl: '/scans/room.glb' }
  assertEquals(fullScanGlbPath(scan, MANIFEST), '/scans/room.opt.glb')
  assertEquals(fullScanGlbPath(scan, null), '/scans/room.glb')
  assertEquals(previewScanGlb(MANIFEST), { path: '/scans/room.lod0.glb', bytes: 10 })
  assertEquals(previewScanGlb(null), null)
  assertEquals(previewScanGlb({ artifacts: { ...MANIFEST.artifacts, lods: [] } }), null)
  assertEquals(optimizationManifestPath('a b.glb'), '/scans/a%20b.glb/manifest')
})

Deno.test('the manifest is fetched through the caller, so it carries the caller\'s token', async () => {
  const asked: string[] = []
  const request = (path: string) => {
    asked.push(addAccessToken(path, 'T'))
    return Promise.resolve(new Response(JSON.stringify(MANIFEST), { headers: { 'Content-Type': 'application/json' } }))
  }
  assertEquals(await fetchOptimizationManifest('room.glb', request), MANIFEST)
  assertEquals(asked, ['/scans/room.glb/manifest?token=T'])
  // No optimized artifact, an error status, or a failed request: no manifest to use.
  const none = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }))
  assertEquals(await fetchOptimizationManifest('room.glb', none({ artifacts: {} })), null)
  assertEquals(await fetchOptimizationManifest('room.glb', none({}, 404)), null)
  assertEquals(await fetchOptimizationManifest('room.glb', () => Promise.reject(new TypeError('Failed to fetch'))), null)
})

Deno.test('applyLocalToWorld places by a column-major 4x4, and leaves the object alone for anything else', () => {
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5), new THREE.Vector3(1, 1, 1))
  const obj = new THREE.Object3D()
  applyLocalToWorld(obj, matrix.toArray())
  assertEquals(obj.position.toArray(), [1, 2, 3])
  const untouched = new THREE.Object3D()
  applyLocalToWorld(untouched, undefined)
  applyLocalToWorld(untouched, [1, 2, 3])
  assertEquals(untouched.position.toArray(), [0, 0, 0])
})

Deno.test('the 4D manifest is requested through the URL builder it is given (the editor passes its token-adding one)', async () => {
  const realFetch = globalThis.fetch
  const asked: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    asked.push(String(input))
    return Promise.resolve(new Response(JSON.stringify({ status: 'ok', frameCount: 3, fps: 5 }), { headers: { 'Content-Type': 'application/json' } }))
  }) as typeof fetch
  try {
    const manifest = await fetchPerson4DManifest('person.glb', (path) => addAccessToken(path, 'T'))
    assertEquals(manifest?.frameCount, 3)
    assertEquals(asked, ['/scans/person.4d-capture.manifest.json?token=T'])
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── A small stand-in for the parts of the DOM the two layout modules touch ──────────────────────────────────

class FakeClassList {
  private readonly names = new Set<string>()
  constructor(initial: string[] = []) { for (const name of initial) this.names.add(name) }
  add(...names: string[]) { for (const name of names) this.names.add(name) }
  remove(...names: string[]) { for (const name of names) this.names.delete(name) }
  contains(name: string) { return this.names.has(name) }
  toggle(name: string, force?: boolean) {
    const on = force ?? !this.names.has(name)
    if (on) this.names.add(name)
    else this.names.delete(name)
    return on
  }
}

class FakeElement {
  textContent: string | null = ''
  parent: FakeElement | null = null
  readonly children: FakeElement[] = []
  readonly classList: FakeClassList
  private readonly attributes = new Map<string, string>()
  private readonly listeners = new Map<string, Array<() => void>>()
  constructor(readonly id: string, classes: string[] = [], readonly tag = 'div') { this.classList = new FakeClassList(classes) }
  appendChild(child: FakeElement) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = this
    this.children.push(child)
    return child
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
  click() { for (const listener of this.listeners.get('click') ?? []) listener() }
  querySelector(selector: string): FakeElement | null {
    if (selector === ':scope > details.layer-tool') return this.children.find((child) => child.tag === 'details' && child.classList.contains('layer-tool')) ?? null
    return this.children.find((child) => child.tag === selector) ?? null
  }
}

function fakeDocument(elements: FakeElement[]) {
  const byId = new Map(elements.map((element) => [element.id, element]))
  return { getElementById: (id: string) => byId.get(id) ?? null }
}

Deno.test('FN-064: the drawer layout moves the Project, Layers and Edit panels and the two layer controls, as the inline script did', async () => {
  const { arrangeDrawerPanels } = await import('../../../src/viewer/editor-layout.ts')
  const host = new FakeElement('details-panel-host')
  const panels = ['world', 'layers', 'edit'].map((name) => new FakeElement(`tab-${name}`, ['sidebar-panel', ...(name === 'world' ? ['active'] : [])]))
  const layerInfo = new FakeElement('sidebar-layer-info')
  const layersPanel = new FakeElement('layers-panel-content')
  const sceneLayers = new FakeElement('scene-layers', ['layer-tool'], 'details')
  layersPanel.appendChild(sceneLayers)
  const quality = new FakeElement('quality-section')
  arrangeDrawerPanels(fakeDocument([host, ...panels, layerInfo, layersPanel, quality]) as unknown as Document)
  assertEquals(host.children.map((child) => child.id), ['tab-world', 'tab-layers', 'tab-edit'])
  for (const panel of panels) {
    assert(panel.classList.contains('details-panel'))
    assert(!panel.classList.contains('sidebar-panel') && !panel.classList.contains('active'))
  }
  assertEquals(layerInfo.children.map((child) => child.id), ['quality-section', 'scene-layers'])
})

Deno.test('FN-064: each drawer collapses and reopens, keeping aria-expanded and its chevron in step, then resizes', async () => {
  const { wireDrawerCollapse, DRAWER_TRANSITION_MS } = await import('../../../src/viewer/editor-layout.ts')
  const sidebar = new FakeElement('sidebar')
  const collapse = new FakeElement('sidebar-collapse-btn')
  const reopen = new FakeElement('sidebar-reopen-tab')
  const details = new FakeElement('details-drawer')
  const detailsCollapse = new FakeElement('details-collapse-btn')
  const detailsReopen = new FakeElement('details-reopen-tab')
  const timers: number[] = []
  const events: string[] = []
  const win = {
    setTimeout: ((handler: () => void, ms: number) => { timers.push(ms); handler(); return 0 }) as unknown as Window['setTimeout'],
    dispatchEvent: (event: Event) => { events.push(event.type); return true },
  }
  wireDrawerCollapse(fakeDocument([sidebar, collapse, reopen, details, detailsCollapse, detailsReopen]) as unknown as Document, win)
  collapse.click()
  assert(sidebar.classList.contains('collapsed'))
  assertEquals([collapse.textContent, collapse.getAttribute('aria-expanded'), reopen.getAttribute('aria-expanded')], ['▶', 'false', 'false'])
  reopen.click()
  assert(!sidebar.classList.contains('collapsed'))
  assertEquals([collapse.textContent, collapse.getAttribute('aria-expanded')], ['◀', 'true'])
  detailsCollapse.click()
  assertEquals([details.classList.contains('collapsed'), detailsCollapse.textContent], [true, '◀'])
  assertEquals(timers, [DRAWER_TRANSITION_MS, DRAWER_TRANSITION_MS, DRAWER_TRANSITION_MS])
  assertEquals(events, ['resize', 'resize', 'resize'])
})

Deno.test('FN-064: viewer.html has no inline script left, and viewer.ts arranges the layout before anything else', async () => {
  const html = await Deno.readTextFile(new URL('../../../viewer.html', import.meta.url))
  assertEquals([...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]), ['<script type="module" src="/src/viewer/viewer.ts">'])
  const source = await Deno.readTextFile(new URL('../../../src/viewer/viewer.ts', import.meta.url))
  const body = source.slice(source.lastIndexOf('\nimport '))
  assert(body.indexOf('arrangeEditorLayout()') < body.indexOf('registerPWA()'), 'the layout runs first')
})

Deno.test('FN-019: in the desktop app the scanner entry says what a computer can do there', async () => {
  const title = new FakeElement('t', [], 'span')
  const detail = new FakeElement('d', [], 'small')
  title.textContent = 'Scan a Place'
  const link = new FakeElement('scan-place-link')
  link.appendChild(title)
  link.appendChild(detail)
  relabelScanEntryForDesktop(fakeDocument([link]) as never)
  assertEquals(title.textContent, DESKTOP_SCAN_ENTRY.title)
  assertEquals(detail.textContent, DESKTOP_SCAN_ENTRY.detail)
  // A page without the entry is left alone.
  relabelScanEntryForDesktop(fakeDocument([]) as never)
  const html = await Deno.readTextFile(new URL('../../../viewer.html', import.meta.url))
  assert(html.includes('<a href="/" id="scan-place-link"'), 'the entry has the id the desktop app finds it by')
  const menu = await Deno.readTextFile(new URL('../../../src/viewer/shell-menu.ts', import.meta.url))
  assert(/if \(isDesktopShell\(\)\) relabelScanEntryForDesktop\(doc\)/.test(menu), 'only the desktop app relabels it')
})
