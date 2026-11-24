/**
 * Clip and pose-track download from the appliance.
 *
 * The contract (the wave-14 session rules, "4D clip access"): every request
 * carries `Authorization: Bearer <FDANYONE_TOKEN>`, and the appliance admits
 * exactly that token on `GET /sessions/:id/clip/:file` and
 * `GET /sessions/:id/pose-track.json` when its session guard is on.
 *
 * The clip route answers a ranged request with at most 8 MiB per 206
 * (MAX_RANGE_BYTES, server/http_range.ts) and a Content-Range saying which
 * bytes it sent. So the clip is fetched in ranges, following Content-Range to
 * the end, and each piece is streamed to disk: a plain GET would make the
 * appliance read the whole clip into memory, which is what its cap exists to
 * stop. A server that ignores Range and answers 200 is accepted too.
 */
import { open, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

export class FetchError extends Error {
  constructor(message, status = null) {
    super(message)
    this.name = 'FetchError'
    this.status = status
  }
}

export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** `bytes 0-8388607/52428800` → `{ start, end, total }` (`total` null for `*`), or null. */
export function parseContentRange(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header ?? '').trim())
  if (!m) return null
  const start = Number(m[1])
  const end = Number(m[2])
  if (end < start) return null
  return { start, end, total: m[3] === '*' ? null : Number(m[3]) }
}

/** Why a request was refused, in words an operator can act on. */
function refusal(status, what) {
  if (status === 401 || status === 403) {
    return `the appliance refused ${what} (HTTP ${status}): set the same FDANYONE_TOKEN here and on the appliance`
  }
  return `the appliance answered HTTP ${status} for ${what}`
}

async function writeBody(res, handle) {
  let written = 0
  if (!res.body) return 0
  for await (const chunk of res.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
      offset += bytesWritten
    }
    written += bytes.byteLength
  }
  return written
}

/**
 * Download `url` to `dest`, following Content-Range. Returns the byte count.
 * Throws a FetchError naming the status on any refusal; a partial file is removed.
 */
export async function downloadToFile(url, dest, { token = null, fetchFn = fetch, timeoutMs = 120_000, what = 'the clip' } = {}) {
  await mkdir(path.dirname(dest), { recursive: true })
  const handle = await open(dest, 'w')
  let ok = false
  try {
    let offset = 0
    // Each 206 must move forward, so this cannot loop forever; the cap is a backstop.
    for (let request = 0; request < 1_000_000; request++) {
      const res = await fetchFn(url, {
        headers: { ...authHeaders(token), Range: `bytes=${offset}-` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 200) {
        if (offset !== 0) throw new FetchError(`${what}: the appliance stopped honouring Range at byte ${offset}`)
        const bytes = await writeBody(res, handle)
        ok = true
        return bytes
      }
      if (res.status === 206) {
        const range = parseContentRange(res.headers.get('content-range'))
        if (!range || range.start !== offset) {
          await res.body?.cancel()
          throw new FetchError(`${what}: unexpected Content-Range ${res.headers.get('content-range') ?? '(none)'} at byte ${offset}`)
        }
        const bytes = await writeBody(res, handle)
        if (bytes !== range.end - range.start + 1) {
          throw new FetchError(`${what}: Content-Range promised ${range.end - range.start + 1} bytes and ${bytes} arrived`)
        }
        offset = range.end + 1
        if (range.total !== null && offset >= range.total) {
          ok = true
          return offset
        }
        continue
      }
      await res.body?.cancel()
      if (res.status === 416 && offset > 0) {
        // Past the end: everything was already received.
        ok = true
        return offset
      }
      throw new FetchError(refusal(res.status, what), res.status)
    }
    throw new FetchError(`${what}: too many range requests`)
  } finally {
    await handle.close()
    if (!ok) await rm(dest, { force: true })
  }
}

/** GET `url` as JSON with the token. Throws a FetchError on a refusal or a body that is not JSON. */
export async function fetchJson(url, { token = null, fetchFn = fetch, timeoutMs = 60_000, what = 'the pose track' } = {}) {
  const res = await fetchFn(url, { headers: authHeaders(token), signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    await res.body?.cancel()
    throw new FetchError(refusal(res.status, what), res.status)
  }
  try {
    return await res.json()
  } catch {
    throw new FetchError(`${what} is not JSON`)
  }
}
