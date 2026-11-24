/**
 * Frames out of a clip, with ffmpeg; the clip's length, with ffprobe.
 *
 * One frame per view per timestep, seeked by time. The spawn is injectable, so
 * the assembly is testable without the binaries, and a run with them is the
 * real path.
 */
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'

/**
 * Run a program to completion. Never rejects: a program that cannot be started
 * comes back as `{ code: -1, spawnError }` so the caller can call it missing.
 */
export function runProcess(bin, args, { spawnFn = spawn, cwd, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', spawnError: err })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => resolve({ code: -1, stdout, stderr, spawnError: err }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, spawnError: null }))
  })
}

/** ffprobe's arguments for a container duration in seconds. Pure. */
export function buildProbeArgs(clipPath) {
  return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', clipPath]
}

/** The clip's duration in ms, or null when ffprobe could not say. */
export async function probeDurationMs(clipPath, { ffprobe, spawnFn } = {}) {
  if (!ffprobe) return null
  const out = await runProcess(ffprobe, buildProbeArgs(clipPath), { spawnFn })
  if (out.code !== 0) return null
  const seconds = Number(String(out.stdout).trim().split('\n')[0])
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
}

/**
 * ffmpeg's arguments for one frame at `timeMs`. Pure, so the order is testable.
 * `-ss` before `-i` seeks the input, and ffmpeg then decodes to the exact time.
 */
export function buildExtractArgs(clipPath, timeMs, outPath) {
  return [
    '-nostdin', '-loglevel', 'error', '-y',
    '-ss', (Math.max(0, timeMs) / 1000).toFixed(3),
    '-i', clipPath,
    '-frames:v', '1',
    '-q:v', '2',
    outPath,
  ]
}

/** Extract one frame. `{ ok: true }`, or `{ ok: false, error }` when nothing usable landed. */
export async function extractFrame(clipPath, timeMs, outPath, { ffmpeg, spawnFn } = {}) {
  const out = await runProcess(ffmpeg, buildExtractArgs(clipPath, timeMs, outPath), { spawnFn })
  if (out.code !== 0) {
    return { ok: false, error: `ffmpeg exited ${out.code} at ${timeMs} ms: ${String(out.stderr).slice(-200)}` }
  }
  try {
    if ((await stat(outPath)).size > 0) return { ok: true }
  } catch { /* fall through */ }
  // A seek past the last frame exits 0 and writes nothing.
  return { ok: false, error: `ffmpeg wrote no frame at ${timeMs} ms` }
}

/**
 * Width and height from a JPEG's first Start-Of-Frame marker, or null. A port
 * of `readJpegDimensions` in the appliance's server/splat/splat_train_dataset.ts:
 * real pixel dimensions, never the recorded ones, because a phone's downscale
 * makes recorded sizes drift.
 */
export function readJpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    let marker = bytes[i + 1]
    while (marker === 0xff && i + 1 < bytes.length) {
      i++
      marker = bytes[i + 1]
    }
    i += 2
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (i + 1 >= bytes.length) break
    const segLen = (bytes[i] << 8) | bytes[i + 1]
    if (segLen < 2) return null
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSOF) {
      if (i + 6 >= bytes.length) return null
      const h = (bytes[i + 3] << 8) | bytes[i + 4]
      const w = (bytes[i + 5] << 8) | bytes[i + 6]
      return w > 0 && h > 0 ? { w, h } : null
    }
    i += segLen
  }
  return null
}

/** The dimensions of a JPEG file, or null. */
export async function jpegFileDimensions(file) {
  try {
    return readJpegDimensions(new Uint8Array(await readFile(file)))
  } catch {
    return null
  }
}
