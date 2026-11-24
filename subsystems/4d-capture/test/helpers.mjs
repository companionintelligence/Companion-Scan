/** Test helpers: a fake spawn, a minimal JPEG, an in-memory ranged clip server. */
import { EventEmitter } from 'node:events'
import { chmod, writeFile } from 'node:fs/promises'

/** A JPEG with just SOI, a baseline SOF0 of `w` x `h`, and EOI: enough for a SOF reader. */
export function tinyJpeg(w, h) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

/**
 * A spawn whose children run `behave(bin, args, opts)` and close with its
 * `code` (default 0). `behave` may write files, the way the real tool would.
 */
export function fakeSpawn(behave) {
  const calls = []
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    setImmediate(async () => {
      try {
        const r = (await behave(bin, args, opts)) ?? {}
        if (r.spawnError) return child.emit('error', r.spawnError)
        if (r.stdout) child.stdout.emit('data', r.stdout)
        if (r.stderr) child.stderr.emit('data', r.stderr)
        child.emit('close', r.code ?? 0)
      } catch (err) {
        child.emit('error', err)
      }
    })
    return child
  }
  return { spawnFn, calls }
}

/** An executable placeholder, so the tool resolver finds it; the spawn is faked. */
export async function placeholderBin(file) {
  await writeFile(file, '#!/bin/sh\nexit 0\n')
  await chmod(file, 0o755)
  return file
}

/**
 * A fetch that serves `files` (url → Buffer | object) like the appliance does:
 * a Range request gets at most `chunk` bytes as a 206 with Content-Range, JSON
 * is served whole, and a request without the right token gets 401.
 */
export function fakeAppliance(files, { token = null, chunk = 1000 } = {}) {
  const seen = []
  const fetchFn = async (url, init = {}) => {
    const headers = new Headers(init.headers)
    seen.push({ url: String(url), auth: headers.get('authorization'), range: headers.get('range') })
    if (token && headers.get('authorization') !== `Bearer ${token}`) return new Response('no', { status: 401 })
    const body = files[String(url)]
    if (body === undefined) return new Response('missing', { status: 404 })
    if (!Buffer.isBuffer(body)) return Response.json(body)
    const range = /^bytes=(\d+)-$/.exec(headers.get('range') ?? '')
    if (!range) return new Response(body, { status: 200 })
    const start = Number(range[1])
    if (start >= body.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${body.length}` } })
    const end = Math.min(body.length, start + chunk) - 1
    return new Response(body.subarray(start, end + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}` },
    })
  }
  return { fetchFn, seen }
}
