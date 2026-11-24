/**
 * The editor's location readout, and the flag on a world whose placements are mirrored.
 *
 * Pure, and kept out of viewer.ts, so the words can be tested without a DOM. Same style as ./scan-calibration-chip.ts: short plain
 * words, and nothing the data does not hold (ADR 0005 rule 3). The decision is docs/adr/0015-scene-convention-and-georeference.md.
 *
 * ## The readout
 *
 * The HUD printed "ENU x, y, z" and a latitude and longitude for every world with a GPS origin. The origin was the newest located
 * scan's fix, the axes were whatever a Place's frame had, and neither was the landmark or north, so the readout looked
 * authoritative and was wrong by the origin scan's GPS error (5 to 65 m indoors) and an unknown rotation. Now:
 *
 *  - a world whose Place is georeferenced, in the scene the georeference defines (x east, y up, z south), says where the point under
 *    the orbit target is: east, north and up of the Place's origin (the landmark) in metres, its latitude and longitude, and how sure
 *    that is, as the record claims it ("approximate to about N m", and "not confirmed" until a person has confirmed it). At the
 *    landmark the latitude and longitude are the record's own;
 *  - any other world says **Local (no georeference)** and prints the point in the scene's own metres, with no latitude, longitude or
 *    compass direction: it has none to give.
 *
 * ## The flag
 *
 * A world file that declares `z: 'north'` was written before the scene was corrected. The scans in it that were placed by GPS and
 * compass are mirrored east to west (a right-handed session cannot be placed in left-handed axes by a rotation), and nothing here
 * recomputes them. A calibrated scan sits in the Place frame and is not mirrored; a scan a person moved is where they put it. So the
 * flag counts the others: "Mirrored placement", with "Re-place by GPS" (which opens the Place location panel: a location set there
 * places the world again) when the world has a Place to save a location for.
 */
import { enuFromScene, enuToGeodetic } from '../world/enu.ts'
import { accuracyAt, isConfirmedGeoreference } from '../world/georef.ts'
import { hasGeoPose } from '../world/geo.ts'
import { isHandPlaced, scansOutsidePlaceFrame } from '../world/scan-hand-placement.ts'
import type { Vec3, WorldProject } from '../world/types.ts'
import { aboutMetres } from './placement-note.ts'

/** What the readout says of a world with no georeference. */
export const LOCAL_READOUT_LABEL = 'Local (no georeference)'

/** What the flag says of a world whose GPS placements are mirrored. */
export const MIRRORED_FLAG_TEXT = 'Mirrored placement'

/** The action beside it. */
export const REPLACE_BY_GPS_LABEL = 'Re-place by GPS'

/** What the flag says when the Place holds a location that was made for an earlier alignment of it, which the world no longer uses. */
export const EARLIER_ALIGNMENT_FLAG_TEXT = 'Location is for an earlier alignment'

/** The action beside it: it opens the Place location panel, where the location is saved again against the alignment the Place holds now. */
export const SET_AGAIN_LABEL = 'Set location again'

/** What the banner of a mixed Place says: how many scans are not in its frame. */
export function notInFrameText(count: number): string {
  return `Not in the Place frame: ${count} scan${count === 1 ? '' : 's'}`
}

/** The fields of a world the readout reads. */
export type ReadoutWorld = Pick<WorldProject, 'georeference' | 'localFrame'>

/** Whether the world is the right-handed scene the georeference defines. */
function isScene(world: Pick<WorldProject, 'localFrame'>): boolean {
  return world.localFrame?.axes?.z === 'south'
}

const fixed = (n: number, digits: number) => (Number.isFinite(n) ? n.toFixed(digits) : '--')

export interface WorldReadout {
  /** True when the readout is a position on Earth. */
  geographic: boolean
  /** The position the lines print, at full precision, when the readout is geographic. */
  position?: { lat: number; lng: number }
  /** One line each, safe to join with line breaks: numbers and fixed words only. */
  lines: string[]
}

/**
 * The readout for `point`, a position in the world's scene, in metres.
 */
export function worldReadout(world: ReadoutWorld, point: Vec3): WorldReadout {
  const georeference = world.georeference
  if (!georeference || !isScene(world)) {
    return { geographic: false, lines: [LOCAL_READOUT_LABEL, `${fixed(point.x, 2)}, ${fixed(point.y, 2)}, ${fixed(point.z, 2)} m`] }
  }
  // The scene's (0, 0, 0) is the Place's origin, the landmark: the world is placed against the record's own origin.
  const enu = enuFromScene(point)
  const origin = { lat: georeference.origin.lat, lng: georeference.origin.lng, altitudeM: georeference.origin.altitudeM ?? 0 }
  const at = enuToGeodetic(origin, enu)
  const away = Math.hypot(enu.east, enu.north)
  const about = aboutMetres(accuracyAt(georeference, away))
  const sure = [
    about === null ? 'Accuracy not recorded' : `Approximate to ${about}`,
    ...(isConfirmedGeoreference(georeference) ? [] : ['not confirmed']),
  ].join(' · ')
  return {
    geographic: true,
    position: { lat: at.lat, lng: at.lng },
    lines: [
      `East ${fixed(enu.east, 2)} · North ${fixed(enu.north, 2)} · Up ${fixed(enu.up, 2)} m`,
      `${fixed(at.lat, 6)}, ${fixed(at.lng, 6)}`,
      sure,
    ],
  }
}

/** The readout as markup for the HUD. Every piece is a number or a fixed word: there is no user text in it to escape. */
export function worldReadoutHtml(world: ReadoutWorld, point: Vec3): string {
  return worldReadout(world, point).lines.join('<br>')
}

type FlagWorld = Pick<WorldProject, 'localFrame' | 'scans' | 'editPatches'>

/**
 * How many scans of a legacy world were placed by GPS and compass and not moved since: the mirrored ones. Zero for a world in the
 * right-handed scene. A scan counts when it has no calibration, was placed by its fix (the server stamps it `'gps-compass'`; a
 * stamp-less row of an older world counts when it has a fix inside the radius and was not marked an outlier) and no person placed it
 * (`isHandPlaced`): a scan reset to its calibration is at the placement the previous build gave it, and is still one of them.
 */
export function mirroredPlacementCount(world: FlagWorld): number {
  if (isScene(world)) return 0
  let count = 0
  for (const scan of world.scans) {
    const calibrated = !!scan.calibrationMethod && scan.calibrationStatus !== 'uncalibrated'
    if (calibrated) continue
    const byGps = scan.placementSource === 'gps-compass'
      || (scan.placementSource === undefined && hasGeoPose(scan.geoPose) && scan.geoDistanceM !== null && scan.geoDistanceM !== undefined && !scan.geoOutlier)
    if (!byGps) continue
    if (isHandPlaced(world.editPatches ?? [], scan)) continue
    count += 1
  }
  return count
}

/** What the flags need to know beyond the world. */
export interface PlacementFlagOptions {
  /** The Place holds a location that was made for an earlier alignment of it (`isEarlierFrame`, ./georeference-form.ts). */
  earlierAlignment?: boolean
}

/**
 * The flags as markup, or an empty string when there is nothing to flag. `canReplace` is whether the world has a Place to save a
 * location for (the legacy default world has none): without one the flag says what is wrong and offers nothing it cannot do.
 *
 * Three things are flagged. A world whose GPS placements are mirrored (above). A mixed Place, one with scans in its frame and others
 * placed by GPS or on the grid (D6): the others are in a different frame, and are left out of matching Things between scans until
 * they are calibrated (`scansOutsidePlaceFrame`; the server's matching leaves out every scan that is not in the Place frame, these with
 * them: `scanTakesPartInThingMatching`, server/thing_match.ts). And a Place whose location was made for an
 * earlier alignment of it: the world does not use that location, so it reads "Local (no georeference)", and without this line nothing
 * on the page says where the location it had went.
 */
export function placementFlagHtml(world: FlagWorld, canReplace: boolean, options: PlacementFlagOptions = {}): string {
  const parts: string[] = []
  if (options.earlierAlignment === true) {
    const title = "The Place's location was saved against an earlier alignment of the Place, which has been made again since. This world does not use it, so scans are not placed on the map until the location is saved again."
    // The same hook as Re-place by GPS: the editor opens the Place location panel on it.
    parts.push(
      `<span class="placement-flag-text" data-flag="earlier-alignment" title="${title}">${EARLIER_ALIGNMENT_FLAG_TEXT}</span>`,
      canReplace ? `<button type="button" class="hud-btn" data-action="replace-by-gps">${SET_AGAIN_LABEL}</button>` : '',
    )
  }
  const count = mirroredPlacementCount(world)
  if (count > 0) {
    const title = `${count} scan${count === 1 ? '' : 's'} in this world ${count === 1 ? 'was' : 'were'} placed by GPS and compass before the scene was corrected, so ${count === 1 ? 'it is' : 'they are'} flipped east to west. Nothing has moved them. ${canReplace ? "Setting the Place's location places them again." : 'Choose a Place to set its location.'}`
    parts.push(
      `<span class="placement-flag-text" title="${title}">${MIRRORED_FLAG_TEXT}: ${count} scan${count === 1 ? '' : 's'}</span>`,
      canReplace ? `<button type="button" class="hud-btn" data-action="replace-by-gps">${REPLACE_BY_GPS_LABEL}</button>` : '',
    )
  }
  const outside = scansOutsidePlaceFrame(world).length
  if (outside > 0) {
    const title = `${outside} scan${outside === 1 ? ' has' : 's have'} no calibration in this Place's frame, so ${outside === 1 ? 'it is' : 'they are'} placed by GPS and compass or on a grid, apart from the rest. ${outside === 1 ? 'It is' : 'They are'} left out of matching things between scans until ${outside === 1 ? 'it is' : 'they are'} calibrated.`
    parts.push(`<span class="placement-flag-text" data-flag="not-in-frame" title="${title}">${notInFrameText(outside)}</span>`)
  }
  return parts.join('')
}
