/**
 * scripts/ingest-video.mjs session ids. The script's default id carries a random tail, so two
 * uploads in the same second get different ids, and it refuses a session directory that already
 * exists rather than overwriting it. Needs ffmpeg and node on PATH; skipped where ffmpeg is missing.
 */
import { assert, assertEquals, assertMatch } from './assert.ts'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../../../server/subprocess.ts'
import { test } from 'node:test'
import { makeTempDir } from '../../../server/fs_util.ts'

const SCRIPT = fileURLToPath(new URL('../../../scripts/ingest-video.mjs', import.meta.url))

async function hasCommand(bin: string, args: string[]): Promise<boolean> {
  try {
    const out = await runCommand(bin, { args, stdout: 'null', stderr: 'null' })
    return out.success
  } catch {
    return false
  }
}

const ffmpegReady = await hasCommand('ffmpeg', ['-version']) && await hasCommand('node', ['--version'])

async function makeClip(dir: string): Promise<string> {
  const out = `${dir}/clip.mp4`
  const made = await runCommand('ffmpeg', {
    args: [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt', 'yuv420p', out,
    ],
    stdout: 'null',
    stderr: 'piped',
  })
  assert(made.success, new TextDecoder().decode(made.stderr))
  return out
}

async function runIngest(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await runCommand('node', { args: [SCRIPT, ...args], stdout: 'piped', stderr: 'piped' })
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

async function listDir(dir: string): Promise<string[]> {
  const names: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) names.push(entry.name)
  return names.sort()
}

test('a --session-id that already has a directory is refused, and the first run is left alone', { skip: !ffmpegReady }, async () => {
    const work = await makeTempDir({ prefix: 'wp-a-ingest-' })
    try {
      const clip = await makeClip(work)
      const sessionsDir = `${work}/sessions`
      const id = 'sess-video-test-000001'
      const args = [clip, '--session-id', id, '--sessions-dir', sessionsDir, '--scans-dir', work, '--fps', '2']

      const first = await runIngest(args)
      assertEquals(first.code, 0, first.stderr)
      const before = await listDir(`${sessionsDir}/${id}`)
      assert(before.some(name => /^kf-\d{5}\.jpg$/.test(name)), 'the first run wrote keyframes')

      const second = await runIngest(args)
      assertEquals(second.code, 2, 'a reused session directory is refused')
      assert(second.stderr.includes('already exists'), second.stderr)
      assertEquals(await listDir(`${sessionsDir}/${id}`), before, 'nothing from the first run was touched')
    } finally {
      await fs.rm(work, { recursive: true })
    }
  })

test('without --session-id, two runs on the same clip in the same second get different sessions', { skip: !ffmpegReady }, async () => {
    const work = await makeTempDir({ prefix: 'wp-a-ingest-' })
    try {
      const clip = await makeClip(work)
      const sessionsDir = `${work}/sessions`
      const args = [clip, '--sessions-dir', sessionsDir, '--scans-dir', work, '--fps', '2']

      const first = await runIngest(args)
      const second = await runIngest(args)
      assertEquals(first.code, 0, first.stderr)
      assertEquals(second.code, 0, second.stderr)

      const ids = [first, second].map(run => JSON.parse(run.stdout.trim().split('\n').at(-1)!).sessionId as string)
      for (const id of ids) assertMatch(id, /^sess-video-\d{8}-\d{6}-[0-9a-f]{8}$/)
      assert(ids[0] !== ids[1], `both runs got ${ids[0]}`)
    } finally {
      await fs.rm(work, { recursive: true })
    }
  })
