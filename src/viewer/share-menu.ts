/**
 * The Spatial Editor's SHARE menu: three entries, each copying one of the place's existing
 * share links (viewer, commenter, editor). A role with no link here is disabled and says
 * "Coming soon". Nothing is minted in this module. The links come from
 * GET /worlds/:slug/share, which the viewer fetches and passes in.
 *
 * The phone-scan link is not one of the three entries. The viewer renders it in the Navigate
 * menu, because its QR helpers live with the viewer.
 */

export type ShareRole = 'viewer' | 'commenter' | 'editor'

export const SHARE_ENTRIES: ReadonlyArray<{ id: string; role: ShareRole; note: string }> = [
  { id: 'share-entry-view', role: 'viewer', note: 'Look around without changing anything.' },
  { id: 'share-entry-comment', role: 'commenter', note: 'Leave review notes; the place stays unchanged.' },
  { id: 'share-entry-edit', role: 'editor', note: 'Change this place and its objects.' },
]

export interface ShareMenu {
  /** Shows the place's links. Pass a failure message instead when the links did not load. */
  apply: (links: Partial<Record<ShareRole, string>> | null, failure?: string) => void
}

export function mountShareMenu(): ShareMenu {
  for (const entry of SHARE_ENTRIES) {
    document.getElementById(entry.id)?.addEventListener('click', (event) => {
      copyEntry(event.currentTarget as HTMLButtonElement)
    })
  }

  const apply = (links: Partial<Record<ShareRole, string>> | null, failure?: string): void => {
    for (const entry of SHARE_ENTRIES) {
      const url = failure ? undefined : links?.[entry.role]
      const status = failure ?? (url ? entry.note : 'Coming soon')
      setEntry(entry.id, url, status, entry.note)
    }
  }

  return { apply }
}

function setEntry(id: string, url: string | undefined, status: string, note: string): void {
  const button = document.getElementById(id) as HTMLButtonElement | null
  const noteEl = button?.querySelector<HTMLElement>('.share-entry-note')
  if (!button || !noteEl) return
  button.dataset['url'] = url ?? ''
  button.dataset['note'] = note
  button.disabled = !url
  noteEl.textContent = status
}

/** Copies an entry's link and says so in the entry's note for a moment. */
function copyEntry(button: HTMLButtonElement): void {
  const url = button.dataset['url']
  const noteEl = button.querySelector<HTMLElement>('.share-entry-note')
  if (!url || !noteEl) return
  const restore = button.dataset['note'] ?? ''
  const flash = (text: string) => {
    noteEl.textContent = text
    setTimeout(() => { noteEl.textContent = restore }, 1500)
  }
  navigator.clipboard.writeText(url).then(() => flash('Link copied'), () => flash('Copy failed'))
}
