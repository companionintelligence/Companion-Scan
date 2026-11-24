/**
 * The Spatial Editor's object panel, in the right drawer's Edit tab. It has two parts: the
 * Object section (name and the physical-thing link) and the XYZ transform fields of a selected
 * object.
 *
 * The viewer owns the scene and the server calls. This module owns the panel's DOM and its
 * events, and reaches the viewer only through the ObjectPanelDeps it is mounted with. Every save
 * goes through the viewer's Edit-panel save queue, so the Edit tab's one status line reports it.
 *
 * What is not here, because the viewer already does it:
 *  - Hide, and the Hidden objects list with its Show buttons (F-20).
 *  - A whole scan's placement. Its numbers are Place precisely's (./stitch-tools.ts), where its
 *    size is locked, so a scan root gets no XYZ fields here.
 *
 * The XYZ conversions are pure and live in ./object-transform.ts.
 */
import type * as THREE from 'three'
import type { Thing } from '../world/types'
import {
  isValidTransformFields,
  parseFieldValue,
  readTransformFields,
  writeTransformFields,
  type TransformAxis,
  type TransformGroup,
} from './object-transform'

export interface ObjectPanelDeps {
  /** The object the Edit tab is showing, or null. */
  selected: () => THREE.Object3D | null
  /** The id the server keys patches by (stableObjectId in the viewer). */
  targetIdOf: (obj: THREE.Object3D) => string
  /** The physical thing an object's observation was matched to, if any. */
  thingFor: (targetId: string) => Thing | null
  /** Shows `name` on the object and saves it. Resolves false when the save did not reach the server. */
  rename: (obj: THREE.Object3D, name: string) => Promise<boolean>
  /** Saves the object's transform. Resolves false when the save did not reach the server. */
  saveTransform: (obj: THREE.Object3D) => Promise<boolean>
  /** Tells everything that follows the gizmo (the readout, the unsaved-move markers) that the object moved. */
  moved: () => void
  /** Keeps the floating inspector's title in step with a rename. */
  setInspectorTitle: (name: string) => void
}

export interface ObjectPanel {
  /** Shows the object's name and link. Called when the Edit tab selects it. */
  sync: (obj: THREE.Object3D, name: string) => void
  /** Shows the selected object's position, rotation and scale in the XYZ fields. */
  syncTransform: () => void
}

const TRANSFORM_INPUTS = '[data-xf-group]'

function setText(id: string, text: string): void {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

/** The panel's own line, for what was typed. Whether a save went through is the Edit tab's save status. */
function setStatus(text: string): void {
  setText('edit-object-status', text)
}

const isScanRoot = (obj: THREE.Object3D): boolean => obj.userData['scope'] === 'scan-root'

export function mountObjectPanel(deps: ObjectPanelDeps): ObjectPanel {
  function thingLinkText(obj: THREE.Object3D): string {
    const thing = deps.thingFor(deps.targetIdOf(obj))
    if (!thing) return 'Not linked to a physical thing'
    return thing.origin === 'user'
      ? `${thing.canonicalLabel} (linked by you)`
      : `${thing.canonicalLabel} (matched across scans)`
  }

  function sync(obj: THREE.Object3D, name: string): void {
    // A patch naming a scan root is not replayed, so a whole scan is not renamed here, and its placement is
    // Place precisely's.
    const scanRoot = isScanRoot(obj)
    const rename = document.getElementById('edit-obj-rename') as HTMLInputElement | null
    if (rename) {
      rename.value = name
      rename.disabled = scanRoot
      rename.title = scanRoot ? 'A whole scan is not renamed here' : ''
    }
    const renameButton = document.getElementById('edit-rename-btn') as HTMLButtonElement | null
    if (renameButton) renameButton.disabled = scanRoot
    const fields = document.getElementById('transform-fields')
    if (fields) fields.hidden = scanRoot
    setText('edit-thing-link', thingLinkText(obj))
    setStatus('')
  }

  async function rename(): Promise<void> {
    const obj = deps.selected()
    const input = document.getElementById('edit-obj-rename') as HTMLInputElement | null
    if (!obj || !input || input.disabled) return
    const name = input.value.trim()
    if (!name) {
      setStatus('Enter a name first.')
      return
    }
    setStatus('')
    setText('edit-obj-name', name)
    deps.setInspectorTitle(name)
    await deps.rename(obj, name)
  }

  function syncTransform(): void {
    const target = deps.selected()
    const fields = target && !isScanRoot(target) ? readTransformFields(target) : null
    for (const input of document.querySelectorAll<HTMLInputElement>(TRANSFORM_INPUTS)) {
      input.classList.remove('is-invalid')
      input.disabled = fields === null
      if (fields === null) {
        input.value = ''
        continue
      }
      // Leave a field alone while it is being typed in. The gizmo can still move the object.
      if (document.activeElement === input) continue
      const group = input.dataset['xfGroup'] as TransformGroup
      const axis = input.dataset['xfAxis'] as TransformAxis
      input.value = String(Number(fields[group][axis].toFixed(4)))
    }
  }

  function commitAxis(input: HTMLInputElement): void {
    const target = deps.selected()
    if (!target || isScanRoot(target)) return
    const group = input.dataset['xfGroup'] as TransformGroup
    const axis = input.dataset['xfAxis'] as TransformAxis
    const value = parseFieldValue(input.value)
    if (value === null) {
      input.classList.add('is-invalid')
      setStatus('Enter a number.')
      return
    }
    // Edit one axis of the object's current values, so the other fields are not rounded by the edit.
    const fields = readTransformFields(target)
    fields[group][axis] = value
    if (!isValidTransformFields(fields)) {
      input.classList.add('is-invalid')
      setStatus('A scale cannot be zero.')
      return
    }
    setStatus('')
    writeTransformFields(target, fields)
    deps.moved()
    void deps.saveTransform(target)
  }

  document.querySelectorAll<HTMLInputElement>(TRANSFORM_INPUTS).forEach((input) => {
    input.addEventListener('change', () => commitAxis(input))
    // Enter commits the way leaving the field does: blurring a changed field fires 'change' once.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur()
    })
  })
  document.getElementById('edit-rename-btn')?.addEventListener('click', () => { void rename() })
  document.getElementById('edit-obj-rename')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void rename()
  })

  return { sync, syncTransform }
}
