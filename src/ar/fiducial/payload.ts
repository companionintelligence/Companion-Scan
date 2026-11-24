/**
 * The line a printed sheet's QR code carries: which tag family it belongs to, which tag, which
 * Place and room, and how big the black square was printed.
 *
 * Why a QR code at all, when the tag already carries its id: the id alone says nothing about where
 * the sheet hangs. The Place, the room and the printed size are what turn "tag 7" into "the kitchen
 * doorway, 200 mm", and the printed size is what makes the pose metric (`tag-pose.ts`). The QR code
 * lets any phone camera app read them off the sheet, and a later step can cross-check them against
 * the tag the detector decoded.
 *
 * Compact JSON with a fixed key order, so a sheet generated twice is byte-identical and the QR code
 * does not change when nothing else did. `parseTagPayload` is strict about what it needs and ignores
 * what it does not know; it never trusts a string it did not validate, because the text arrives from
 * the world.
 *
 * Browser-safe (ADR 0002).
 */
import type { TagPayload } from './types.ts'

/** Longest id string accepted for a Place or room. Adopted, not measured: ids in the repo are UUIDs and slugs, well under this. */
const MAX_ID_LENGTH = 200
/** Largest printed size accepted, millimetres. A sheet bigger than a poster is a typo. Adopted, not measured. It also bounds a partner's offset: a second tag farther than a poster is wide is a typo. */
const MAX_PRINTED_SIZE_MM = 5000
/** Tallest mount height accepted, millimetres: the same 4 m `tag-frame.ts` allows a tag centre above the floor. Adopted, not measured. */
const MAX_MOUNT_HEIGHT_MM = 4000

export function serializeTagPayload(payload: TagPayload): string {
  // The base keys in their fixed order, then the optional ones in theirs: a payload without them is byte-for-byte what it always was.
  const out: Record<string, unknown> = {
    v: payload.v,
    family: payload.family,
    tagId: payload.tagId,
    placeId: payload.placeId,
    roomId: payload.roomId,
    printedSizeMm: payload.printedSizeMm,
  }
  if (payload.mount !== undefined) out['mount'] = payload.mount
  if (payload.mountHeightMm !== undefined) out['mountHeightMm'] = payload.mountHeightMm
  if (payload.partner !== undefined) out['partner'] = { tagId: payload.partner.tagId, dxMm: payload.partner.dxMm, dyMm: payload.partner.dyMm }
  return JSON.stringify(out)
}

function idText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null
}

/** The payload a QR code carried, or null when the text is not one this version wrote. */
export function parseTagPayload(text: string): TagPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1) return null
  const family = idText(o['family'])
  const placeId = idText(o['placeId'])
  if (family === null || placeId === null) return null
  const tagId = o['tagId']
  if (typeof tagId !== 'number' || !Number.isInteger(tagId) || tagId < 0) return null
  const printedSizeMm = o['printedSizeMm']
  if (typeof printedSizeMm !== 'number' || !Number.isFinite(printedSizeMm) || printedSizeMm <= 0 || printedSizeMm > MAX_PRINTED_SIZE_MM) return null
  const roomRaw = o['roomId']
  const roomId = roomRaw === null || roomRaw === undefined ? null : idText(roomRaw)
  if (roomRaw !== null && roomRaw !== undefined && roomId === null) return null
  const payload: TagPayload = { v: 1, family, tagId, placeId, roomId, printedSizeMm }

  // The optional members: absent is fine, present and wrong is not (the text came from the world).
  const mount = o['mount']
  if (mount !== undefined) {
    if (mount !== 'wall' && mount !== 'horizontal') return null
    payload.mount = mount
  }
  const height = o['mountHeightMm']
  if (height !== undefined) {
    if (payload.mount === undefined || typeof height !== 'number' || !Number.isFinite(height) || height < 0 || height > MAX_MOUNT_HEIGHT_MM) return null
    payload.mountHeightMm = height
  }
  const partner = o['partner']
  if (partner !== undefined) {
    if (typeof partner !== 'object' || partner === null || Array.isArray(partner)) return null
    const p = partner as Record<string, unknown>
    const partnerId = p['tagId']
    const dx = p['dxMm']
    const dy = p['dyMm']
    if (typeof partnerId !== 'number' || !Number.isInteger(partnerId) || partnerId < 0 || partnerId === tagId) return null
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return null
    if (Math.abs(dx) > MAX_PRINTED_SIZE_MM || Math.abs(dy) > MAX_PRINTED_SIZE_MM || (dx === 0 && dy === 0)) return null
    payload.partner = { tagId: partnerId, dxMm: dx, dyMm: dy }
  }
  return payload
}
