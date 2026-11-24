/**
 * The one form that edits a detection's label and description, used by the side panel's list
 * (./panel.ts) and by the history drawer's rows (./history.ts) (F-44).
 *
 * The two used to build their own forms. They were the same markup under different class names, with
 * two copies of the save rule, and the drawer's had no placeholders. The structure is built here and
 * the text goes in as DOM properties, never into the markup: a label is model or person text, and
 * `Samsung 27" monitor` once cut a `value="…"` attribute short (tests/mock-pin-edit.spec.ts).
 *
 * Where the form sits, and what happens around a save (closing it, keeping a draft across a re-render),
 * stays with each caller, which gets the fields back. The form owns its fields, its two buttons and the
 * save rule.
 */

/** A detection's editable text. */
export interface DetectionText {
  label: string
  description: string
}

/**
 * What a save writes: each field as typed, trimmed, or the stored text when the field was left
 * empty. A field holding only spaces counts as empty. The old rule (`(typed || stored).trim()`)
 * saved a label of spaces as an empty label.
 */
export function editedText(typed: DetectionText, stored: DetectionText): DetectionText {
  return {
    label: typed.label.trim() || stored.label.trim(),
    description: typed.description.trim() || stored.description.trim(),
  }
}

export interface DetectionEditFormOptions {
  /** What the fields open with: a draft the caller kept, or the stored text. */
  initial: DetectionText
  /** The stored text, which an empty field falls back to on save. */
  stored: DetectionText
  /** Called with what a save writes, after the click. The caller closes the form and writes the store. */
  onSave: (text: DetectionText) => void | Promise<void>
  onCancel: () => void
}

export interface DetectionEditForm {
  element: HTMLElement
  labelInput: HTMLInputElement
  descInput: HTMLTextAreaElement
  saveBtn: HTMLButtonElement
  cancelBtn: HTMLButtonElement
}

/** Build the form, hidden or shown as the caller styles `element`. */
export function buildDetectionEditForm(options: DetectionEditFormOptions): DetectionEditForm {
  const element = document.createElement('div')
  element.innerHTML = `
    <input type="text" placeholder="Label"
      class="ci-field"
      style="margin-bottom:5px;" />
    <textarea placeholder="Description" rows="2"
      class="ci-field ci-textarea"></textarea>
    <div style="display:flex;gap:6px;margin-top:5px;">
      <button class="edit-save ci-inline-btn ci-inline-btn--primary" style="flex:1;">Save</button>
      <button class="edit-cancel ci-inline-btn ci-inline-btn--muted" style="flex:1;">Cancel</button>
    </div>
  `
  const labelInput = element.querySelector<HTMLInputElement>('input')!
  const descInput = element.querySelector<HTMLTextAreaElement>('textarea')!
  const saveBtn = element.querySelector<HTMLButtonElement>('.edit-save')!
  const cancelBtn = element.querySelector<HTMLButtonElement>('.edit-cancel')!
  labelInput.value = options.initial.label
  descInput.value = options.initial.description

  const typed = (): DetectionText => ({ label: labelInput.value, description: descInput.value })
  // stopPropagation: a click in the form is not a click on the card or row it sits in.
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    Promise.resolve(options.onSave(editedText(typed(), options.stored))).catch((error: unknown) => {
      console.warn('[edit] the edit was not saved:', error)
    })
  })
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    options.onCancel()
  })
  return { element, labelInput, descInput, saveBtn, cancelBtn }
}
