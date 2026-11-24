/**
 * Wave 14, ticket 0003 (scanner-ui), F-44: the scanner UI's one colour lookup and its one detection edit form.
 *
 *  - src/ui/category-color.ts: pins, the side panel and the history drawer draw a label in its CV_PALETTE colour
 *    (src/shared/cv-palette.ts), through one alias list, and an unknown label in the palette's default grey.
 *  - src/ui/detection-edit-form.ts: the panel and the drawer build the same form, and save by the same rule.
 *
 * Run: node --experimental-strip-types --no-warnings --test tests/unit/node/wp-14-scanner-ui-shared-ui.test.ts
 * Also run by npm run test:wave.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CV_PALETTE, paletteColorFor } from '../../../src/shared/cv-palette.ts'
import { MATCH_ORDER, PALETTE_ALIASES, categoryColor, categoryTextColor, paletteLabelOf } from '../../../src/ui/category-color.ts'
import { buildDetectionEditForm, editedText } from '../../../src/ui/detection-edit-form.ts'

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
const hex = (rgb: readonly number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`

// ── The colour lookup ────────────────────────────────────────────────────────────────────────────

test('every palette label is drawn in its palette colour', () => {
  for (const entry of CV_PALETTE) assert.equal(categoryColor(entry.label), hex(entry.rgb), entry.label)
})

test('a label no table knows gets the palette default, the grey the three old tables shared', () => {
  // 'mug', not 'door': door has a key, and a colour of its own once capture-core's display table is merged.
  assert.equal(categoryColor('mug'), hex(paletteColorFor('')))
  assert.equal(categoryColor('mug'), '#b0bec5')
  assert.equal(categoryColor(''), '#b0bec5')
})

test('every alias points at a palette label, and every palette label is a key', () => {
  const labels = new Set(CV_PALETTE.map((entry) => entry.label))
  for (const [word, target] of Object.entries(PALETTE_ALIASES)) assert.ok(labels.has(target), `${word} → ${target}`)
  for (const label of labels) assert.ok(MATCH_ORDER.includes(label), `${label} can be matched`)
})

test('a label is matched as the old tables and the GLB export match it: the first key it contains, in order', () => {
  // The order capture-core's labelDisplayRgb (src/shared/cv-palette.ts, ticket 0004) uses, so the pins and the
  // GLB agree once both are merged. See the header of src/ui/category-color.ts.
  assert.deepEqual([...MATCH_ORDER], [
    'chair', 'table', 'sofa', 'couch', 'bed', 'desk', 'monitor', 'tv', 'door', 'window',
    'shelf', 'bookcase', 'lamp', 'plant', 'wall', 'floor', 'ceiling',
  ])
  assert.equal(paletteLabelOf('Office Chair'), 'chair')
  assert.equal(paletteLabelOf('bedside table'), 'table', 'table comes before bed')
  assert.equal(paletteLabelOf('table lamp'), 'table', 'the first key in the order wins, as in the GLB')
  assert.equal(paletteLabelOf('couch'), 'sofa')
  assert.equal(paletteLabelOf('computer monitor'), 'tv')
  assert.equal(paletteLabelOf('bookcase'), 'shelf')
  assert.equal(paletteLabelOf('potted plant'), 'plant')
  assert.equal(paletteLabelOf('desk'), null, 'a key with no palette colour')
  assert.equal(paletteLabelOf('desk lamp'), null, 'desk is found first, and has no palette colour')
  assert.equal(paletteLabelOf('mug'), null)
})

test('text gets the colour mixed halfway to white, so a dark palette colour stays readable', () => {
  assert.equal(categoryTextColor('table'), hex(paletteColorFor('table').map((c) => Math.round(c + (255 - c) / 2))))
  // walnut, rgb(109, 76, 65), is the darkest entry: its text colour is light enough for near-black panels.
  const [r, g, b] = categoryTextColor('table').slice(1).match(/../g)!.map((pair) => parseInt(pair, 16))
  assert.ok(Math.min(r!, g!, b!) >= 150, `walnut text is ${categoryTextColor('table')}`)
})

test('source shape: the pins, the panel and the history drawer have no colour table of their own', () => {
  for (const path of ['src/ui/overlay.ts', 'src/ui/panel.ts', 'src/ui/history.ts']) {
    const source = read(path)
    assert.match(source, /from '\.\/category-color\.ts'/, `${path} imports the one lookup`)
    assert.doesNotMatch(source, /CATEGORY_COLORS|const COLORS\b/, `${path} has no table`)
    assert.doesNotMatch(source, /'#72ddd4', table|chair: '#/, `${path} has no colour literal per label`)
  }
  assert.doesNotMatch(read('src/ui/category-color.ts'), /rgb: \[|#[0-9a-f]{6}'|\[\d+, \d+, \d+\]/i, 'the lookup holds no colours, only keys and aliases')
})

// ── The edit form ────────────────────────────────────────────────────────────────────────────────

test('a save writes each field trimmed, or the stored text where the field was left empty', () => {
  const stored = { label: 'sofa', description: 'a grey sofa' }
  assert.deepEqual(editedText({ label: '  couch ', description: '' }, stored), { label: 'couch', description: 'a grey sofa' })
  assert.deepEqual(editedText({ label: '', description: ' by the window ' }, stored), { label: 'sofa', description: 'by the window' })
  assert.deepEqual(
    editedText({ label: '   ', description: '   ' }, stored),
    stored,
    'a field of spaces is empty: the old rule saved it as an empty label',
  )
  assert.deepEqual(editedText({ label: 'Samsung 27" monitor', description: 'x' }, stored).label, 'Samsung 27" monitor')
})

/** Just enough of the document for the form: createElement, an innerHTML read for its tags, and querySelector. */
class FakeEl {
  tag: string
  className = ''
  value = ''
  placeholder = ''
  children: FakeEl[] = []
  style: Record<string, string> = {}
  listeners = new Map<string, Array<(event: unknown) => void>>()
  private html = ''
  constructor(tag: string) { this.tag = tag }
  get innerHTML(): string { return this.html }
  set innerHTML(markup: string) {
    this.html = markup
    this.children = []
    for (const [, tag, attributes] of markup.matchAll(/<(\w+)([^>]*)>/g)) {
      const child = new FakeEl(tag!)
      child.className = /class="([^"]*)"/.exec(attributes!)?.[1] ?? ''
      child.placeholder = /placeholder="([^"]*)"/.exec(attributes!)?.[1] ?? ''
      this.children.push(child)
    }
  }
  querySelector(selector: string): FakeEl | null {
    return this.children.find((child) => (selector.startsWith('.')
      ? child.className.split(' ').includes(selector.slice(1))
      : child.tag === selector)) ?? null
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({ stopPropagation() {} }) }
}

function withFakeDocument<T>(run: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>
  const before = g['document']
  g['document'] = { createElement: (tag: string) => new FakeEl(tag) }
  try {
    return run()
  } finally {
    g['document'] = before
  }
}

test('the form opens with what it is given, as properties, and has the panel\'s placeholders and classes', () => {
  const form = withFakeDocument(() => buildDetectionEditForm({
    initial: { label: 'Samsung 27" monitor', description: 'by the <window>' },
    stored: { label: 'tv', description: '' },
    onSave: () => {},
    onCancel: () => {},
  }))
  const element = form.element as unknown as FakeEl
  assert.equal(form.labelInput.value, 'Samsung 27" monitor')
  assert.equal(form.descInput.value, 'by the <window>')
  assert.doesNotMatch(element.innerHTML, /Samsung|window/, 'no text in the markup')
  assert.equal((form.labelInput as unknown as FakeEl).placeholder, 'Label')
  assert.equal((form.descInput as unknown as FakeEl).placeholder, 'Description')
  assert.ok((form.saveBtn as unknown as FakeEl).className.includes('edit-save'), 'tests/mock-pin-edit.spec.ts clicks .edit-save')
})

test('Save hands the saved text to the caller; Cancel hands nothing', async () => {
  const saved: Array<{ label: string, description: string }> = []
  let cancelled = 0
  const form = withFakeDocument(() => buildDetectionEditForm({
    initial: { label: 'sofa', description: 'grey' },
    stored: { label: 'sofa', description: 'grey' },
    onSave: (text) => { saved.push(text) },
    onCancel: () => { cancelled++ },
  }))
  form.labelInput.value = ' couch '
  form.descInput.value = ''
  ;(form.saveBtn as unknown as FakeEl).click()
  ;(form.cancelBtn as unknown as FakeEl).click()
  await Promise.resolve()
  assert.deepEqual(saved, [{ label: 'couch', description: 'grey' }])
  assert.equal(cancelled, 1)
})

test('a save that fails is logged, not left as an unhandled rejection', async () => {
  const warned: unknown[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args) }
  try {
    const form = withFakeDocument(() => buildDetectionEditForm({
      initial: { label: 'a', description: 'b' },
      stored: { label: 'a', description: 'b' },
      onSave: () => Promise.reject(new Error('store refused')),
      onCancel: () => {},
    }))
    ;(form.saveBtn as unknown as FakeEl).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    console.warn = warn
  }
  assert.equal(warned.length, 1)
})

test('source shape: the panel and the drawer build the one form and keep no form markup of their own', () => {
  for (const path of ['src/ui/panel.ts', 'src/ui/history.ts']) {
    const source = read(path)
    assert.match(source, /buildDetectionEditForm\(\{/, `${path} builds the shared form`)
    assert.doesNotMatch(source, /<textarea|ef-save|edit-save ci-inline-btn/, `${path} has no form markup of its own`)
    assert.match(source, /await this\.store\.updateDetection\(key, text\)/, `${path} writes what the form says to write`)
  }
})
