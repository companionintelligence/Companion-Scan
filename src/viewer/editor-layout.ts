/**
 * The editor's drawer layout (FN-064): which panels the right drawer holds, and the two collapse buttons.
 *
 * This was two inline scripts in viewer.html, a third that repeated what `switchSidebarTab` (./viewer.ts) already does
 * on a tab click, and viewer.ts's own layout rules beside them. It is code now, run by viewer.ts before anything reads
 * the panels.
 *
 *  - The Project, Layers and Edit panels move from the left rail into the right drawer (`#details-panel-host`), and the
 *    Map Quality headline and the Scene layers list move to `#sidebar-layer-info` beside the navigation. The panels move
 *    as they are: the same nodes, so ids and every listener stay.
 *  - Each drawer's collapse button and its reopen tab (outside the clipped drawer, so a collapsed drawer can always be
 *    reopened) toggle `collapsed`, keep `aria-expanded` and the chevron in step, and then fire `resize`, which the
 *    renderer listens to once the width transition has finished.
 *
 * Which panel shows for which tab, `#sidebar-layer-info` included, is `switchSidebarTab`'s alone.
 */

/** How long the drawers' width transition runs before the renderer is told to resize, in ms (viewer.html's CSS). */
export const DRAWER_TRANSITION_MS = 250

/** Move the Project, Layers and Edit panels into the right drawer, and the read-most-used layer controls to the rail. */
export function arrangeDrawerPanels(doc: Document = document): void {
  const host = doc.getElementById('details-panel-host')
  if (!host) return
  for (const name of ['world', 'layers', 'edit']) {
    const panel = doc.getElementById(`tab-${name}`)
    if (!panel) continue
    panel.classList.remove('sidebar-panel', 'active')
    panel.classList.add('details-panel')
    host.appendChild(panel)
  }

  const layerInfo = doc.getElementById('sidebar-layer-info')
  const layersPanel = doc.getElementById('layers-panel-content')
  if (layerInfo && layersPanel) {
    // The active scan's most-read visual controls, beside navigation.
    const mapQuality = doc.getElementById('quality-section')
    const sceneLayers = layersPanel.querySelector(':scope > details.layer-tool')
    if (mapQuality) layerInfo.appendChild(mapQuality)
    if (sceneLayers) layerInfo.appendChild(sceneLayers)
  }
}

/** One drawer's collapse wiring: the button inside it, the reopen tab outside it, and the chevrons each shows. */
interface DrawerControls {
  drawer: string
  collapse: string
  reopen: string
  /** The collapse button's chevron while the drawer is open, and while it is collapsed. */
  openGlyph: string
  collapsedGlyph: string
}

const DRAWERS: readonly DrawerControls[] = [
  { drawer: 'sidebar', collapse: 'sidebar-collapse-btn', reopen: 'sidebar-reopen-tab', openGlyph: '◀', collapsedGlyph: '▶' },
  { drawer: 'details-drawer', collapse: 'details-collapse-btn', reopen: 'details-reopen-tab', openGlyph: '▶', collapsedGlyph: '◀' },
]

/** Wire both drawers' collapse buttons and reopen tabs. `win` is where the resize is fired, for a test. */
export function wireDrawerCollapse(doc: Document = document, win: Pick<Window, 'dispatchEvent' | 'setTimeout'> = window): void {
  for (const controls of DRAWERS) {
    const drawer = doc.getElementById(controls.drawer)
    const collapse = doc.getElementById(controls.collapse)
    const reopen = doc.getElementById(controls.reopen)
    if (!drawer || !collapse || !reopen) continue
    const setCollapsed = (collapsed: boolean): void => {
      drawer.classList.toggle('collapsed', collapsed)
      collapse.textContent = collapsed ? controls.collapsedGlyph : controls.openGlyph
      collapse.setAttribute('aria-expanded', String(!collapsed))
      reopen.setAttribute('aria-expanded', String(!collapsed))
      // Resize the renderer once the width transition has finished.
      win.setTimeout(() => win.dispatchEvent(new Event('resize')), DRAWER_TRANSITION_MS)
    }
    collapse.addEventListener('click', () => setCollapsed(!drawer.classList.contains('collapsed')))
    reopen.addEventListener('click', () => setCollapsed(false))
  }
}

/** The whole layout, as viewer.html's inline scripts used to apply it. */
export function arrangeEditorLayout(doc: Document = document): void {
  arrangeDrawerPanels(doc)
  wireDrawerCollapse(doc)
}
