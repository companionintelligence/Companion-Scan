/**
 * Shared fixtures for the floor-plan tests (floor_plan.test.ts, floor_plan_server.test.ts): a synthetic box room
 * written as a LingBot-Map PLY from TS, and the interpreter the floor-plan job would run, when this machine has one.
 */
import { locateTool, runnerToolLookup } from '../../../server/exec_probe.ts'

/** Truth for the box room: 4 x 3 with a 2.5 ceiling, so 12 square units of floor. */
export const ROOM = { width: 4.0, depth: 3.0, height: 2.5 } as const

/** A PLY with a header and no points: enough to be "a cloud on disk" for the paths that never run the worker. */
export const TINY_PLY = new TextEncoder().encode(
  'ply\nformat binary_little_endian 1.0\nelement vertex 0\n' +
    'property float x\nproperty float y\nproperty float z\nend_header\n',
)

/** Deterministic PRNG so the fixture (and the seeded worker) never flakes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Write a ~50k-point box room in the LingBot-Map PLY layout (binary LE, float32 x/y/z + uchar r/g/b): floor and
 * ceiling planes and four walls, with a little sensor-like jitter. Z is up. Returns the point count.
 */
export async function writeBoxRoomPly(path: string): Promise<number> {
  const rand = mulberry32(1234)
  const gauss = (sigma: number) => {
    // Box-Muller; the log argument kept away from 0.
    const u = Math.max(rand(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma
  }
  const pts: number[] = []
  const push = (x: number, y: number, z: number) => { pts.push(x, y, z) }
  const N_PLANE = 12000
  const N_WALL = 6500
  for (const z of [0, ROOM.height]) {
    for (let i = 0; i < N_PLANE; i++) push(rand() * ROOM.width, rand() * ROOM.depth, z + gauss(0.005))
  }
  for (const x of [0, ROOM.width]) {
    for (let i = 0; i < N_WALL; i++) push(x + gauss(0.008), rand() * ROOM.depth, rand() * ROOM.height)
  }
  for (const y of [0, ROOM.depth]) {
    for (let i = 0; i < N_WALL; i++) push(rand() * ROOM.width, y + gauss(0.008), rand() * ROOM.height)
  }
  const count = pts.length / 3
  const header = 'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${count}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    'end_header\n'
  const headerBytes = new TextEncoder().encode(header)
  const body = new Uint8Array(count * 15)
  const view = new DataView(body.buffer)
  for (let i = 0; i < count; i++) {
    const off = i * 15
    view.setFloat32(off, pts[i * 3]!, true)
    view.setFloat32(off + 4, pts[i * 3 + 1]!, true)
    view.setFloat32(off + 8, pts[i * 3 + 2]!, true)
    body[off + 12] = 128
    body[off + 13] = 128
    body[off + 14] = 128
  }
  const out = new Uint8Array(headerBytes.length + body.length)
  out.set(headerBytes, 0)
  out.set(body, headerBytes.length)
  await Deno.writeFile(path, out)
  return count
}

async function runs(bin: string, args: string[]): Promise<boolean> {
  try {
    return (await new Deno.Command(bin, { args, stdout: 'null', stderr: 'null' }).output()).success
  } catch {
    return false
  }
}

/**
 * The interpreter the floor-plan job would run here, found the way the driver finds it (LINGBOT_MAP_PYTHON, then
 * python3 on PATH), or null. `numpy` says whether it can run the worker; without it the worker exits 3.
 */
export async function floorPlanPython(): Promise<{ path: string; numpy: boolean } | null> {
  const found = await locateTool(runnerToolLookup('lingbot-map-python'))
  if (!found.found || !found.path) return null
  return { path: found.path, numpy: await runs(found.path, ['-c', 'import numpy']) }
}
