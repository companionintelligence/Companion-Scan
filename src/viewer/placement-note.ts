/**
 * What the editor's scan list says about how a scan was PLACED: the line that takes the GPS accuracy's place for a scan with no
 * calibration, and the lines beside a calibrated scan's chip when a georeference carried it.
 *
 * Pure, and kept out of viewer.ts, so the words can be tested without a DOM. Same style as ./scan-calibration-chip.ts and
 * src/ar/alignment-status.ts: short plain words, and nothing the data does not hold (ADR 0005 rule 3). The data is
 * `ScanManifest.placementSource`, `placementUncertaintyM` and `placementStale`, written by the server's placement step
 * (server/world/world_origin.ts, docs/adr/0015-scene-convention-and-georeference.md).
 *
 * ## What each source proves, and so what may be said
 *
 *  - `'place-frame'`: the scan sits exactly where its calibration put it in the Place, and no georeference carries it: it has a
 *    place in the Place and none on Earth. A calibrated scan's chip already says how it was calibrated, so this adds nothing there.
 *  - `'georeference'`: the Place's frame was carried onto the map by the Place's georeference. The scan is where that record puts it,
 *    approximately: how far it may be out is the record's own claim (its origin accuracy and its bearing's, at the scan's
 *    distance from the origin), not a measurement, so it reads "approximate to about N m" and never "within N m".
 *  - `'gps-compass'`: a scan with no calibration, placed from the phone's fix and compass. It is not in the Place frame (a different
 *    reference altogether), and it is approximate: the uncertainty is the fix's accuracy as the server read it, at least 10 m. A world
 *    from before the scene was corrected stamps the same source with no figure: its placement is the phone's own heading in mirrored
 *    axes, and the line says so and states none.
 *  - `'grid'`: nothing usable to place it by. It stands on a grid, unturned, and says it was not placed.
 *
 * A scan that was moved by hand before the Place's location was set is flagged `placementStale`: it did not move, and its
 * position on the map is from before the location. That is a statement about timing, and the line says that and no more.
 *
 * A scan a person placed (`isHandPlaced`, src/world/scan-hand-placement.ts: a move that still counts holds it somewhere other than where
 * its calibration puts it) is where they put it. What put it there before is no longer what holds it, so the line says it was placed by
 * hand, and none of the claims above is made about it: not its accuracy, and not that it is on the map.
 *
 * A figure that is absent or not a finite number prints no figure, never "NaN m".
 */
import type { ScanManifest } from '../world/types.ts'

/** The placement fields of a `ScanManifest` the note reads. */
export type PlacementScan = Pick<ScanManifest, 'placementSource' | 'placementUncertaintyM' | 'placementStale'>

export interface PlacementNoteOptions {
  /** Whether a person placed the scan (`isHandPlaced`): the placement the manifest names is then not what holds it. */
  placedByHand?: boolean
}

export interface PlacementNote {
  /** Takes the place of the GPS accuracy on a scan with no calibration. Null where the calibration chip already says it all. */
  text: string | null
  /** A second visible line, for what the source does not prove. Null when there is nothing to add. */
  note: string | null
  /** A visible line when the scan was moved by hand before the Place's location was set. Null otherwise. */
  staleLine: string | null
  /** The longer explanation, for hover and for assistive technology. */
  title: string
}

/** Whole metres for a distance, as a person would say it: "about 4 m". Null for a number that does not exist, or one that is not above 0. */
export function aboutMetres(metres: number | null | undefined): string | null {
  if (typeof metres !== 'number' || !Number.isFinite(metres) || metres <= 0) return null
  return metres < 10 ? `about ${Number(metres.toPrecision(2))} m` : `about ${Math.round(metres)} m`
}

const STALE_TITLE = "The Place's location was set after this scan was moved by hand. It has not moved, so its position on the map is from before the location. Reset to calibrated puts it where the location says."

const BY_HAND_TEXT = 'Placed by hand'
const BY_HAND_TITLE = 'A person moved this scan. It is where they put it, and nothing here says how close that is to the map.'

/**
 * The note for one scan, or null for a scan with nothing to say (a manifest from before placements were recorded: absence is not a
 * claim, and the scan list keeps the text it always had).
 */
export function placementNote(scan: PlacementScan, options: PlacementNoteOptions = {}): PlacementNote | null {
  const source = scan.placementSource
  const staleLine = scan.placementStale === true ? 'Moved before the location was set' : null
  const stale = (title: string) => (staleLine ? `${title} ${STALE_TITLE}` : title)
  const about = aboutMetres(scan.placementUncertaintyM)

  if (options.placedByHand === true) return { text: BY_HAND_TEXT, note: null, staleLine, title: stale(BY_HAND_TITLE) }

  if (source === 'place-frame') {
    if (!staleLine) return null
    return { text: null, note: null, staleLine, title: stale('Sits where its calibration put it in the Place.') }
  }

  if (source === 'georeference') {
    return {
      text: about === null ? 'On the map' : `On the map, approximate to ${about}`,
      note: null,
      staleLine,
      title: stale(`Placed on the map by the Place's location and heading. ${about === null ? 'How far it may be out is not recorded.' : `It may be out by ${about}, and more at the far side of a large room.`}`),
    }
  }

  if (source === 'gps-compass') {
    return {
      text: about === null ? 'Placed by GPS and compass' : `Placed by GPS and compass, approximate to ${about}`,
      note: 'Not in the Place frame',
      staleLine,
      title: stale(
        about === null
          ? 'This scan has no calibration. It was placed from the phone\'s GPS fix and compass at capture, in a world from before the scene was corrected, so how far it is from where it was scanned, and which way it is turned, is not known. It is not in the Place frame.'
          : 'This scan has no calibration. It was placed from the phone\'s GPS fix and compass at capture, so it may be off by several metres and turned a little. It is not in the Place frame.',
      ),
    }
  }

  if (source === 'grid') {
    return {
      text: 'Not placed: on the grid',
      note: 'Not in the Place frame',
      staleLine,
      title: stale('This scan has no calibration and no usable GPS fix and compass reading, so it stands on a grid, 3 m apart, until it is moved.'),
    }
  }

  // No source (a manifest from before placements were recorded, or a scan of another frame that this says nothing about): a moved
  // scan can still carry the flag.
  return staleLine ? { text: null, note: null, staleLine, title: STALE_TITLE } : null
}
