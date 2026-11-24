/**
 * Shared fixtures for the floor-plan tests (floor_plan.test.ts, floor_plan_server.test.ts): a synthetic box room
 * written as a LingBot-Map PLY from TS, a captured room (the same room and its cameras, posed by the AR runtime in a
 * metric Y-up frame and by LingBot-Map in a frame of its own), and the interpreter the floor-plan job would run, when
 * this machine has one.
 */
import { locateTool, runnerToolLookup } from '../../../server/exec_probe.ts'
import * as fs from 'node:fs/promises'
import { runCommand } from '../../../server/subprocess.ts'

/** Truth for the captured room: 4 x 3 m with a 2.5 m ceiling, so 12 m² of floor. */
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

async function runs(bin: string, args: string[]): Promise<boolean> {
  try {
    return (await runCommand(bin, { args, stdout: 'null', stderr: 'null' })).success
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

// ── A captured room: the AR frame, LingBot's frame, and the cameras in both ──────────────────────────────────────

export type Mat3 = number[][]
export type Vec3 = [number, number, number]

/** How LingBot-Map's frame sits against the AR session's: p_lb = scale·rotation·p_ar + translation. */
export interface LingbotFrame {
  scale: number
  rotation: Mat3
  translation: Vec3
}

/** A rotation of `deg` degrees about `axis` (Rodrigues). */
export function axisAngle(axis: Vec3, deg: number): Mat3 {
  const n = Math.hypot(axis[0], axis[1], axis[2])
  const [x, y, z] = [axis[0] / n, axis[1] / n, axis[2] / n]
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ]
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!))
}

export function apply3(m: Mat3, v: Vec3): Vec3 {
  return [0, 1, 2].map((i) => m[i]![0]! * v[0] + m[i]![1]! * v[1] + m[i]![2]! * v[2]) as Vec3
}

export function transposeM(m: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j]![i]!))
}

/**
 * The default LingBot frame: a third of a metre per unit, up tilted 35° off every axis, and moved. The worker's
 * narrowest-span guess and its metre thresholds both fail in it, so a plan that comes out right was fitted.
 */
export const LINGBOT_TILTED: LingbotFrame = {
  scale: 0.3,
  rotation: axisAngle([1, 0.4, -0.3], 35),
  translation: [0.7, -1.1, 2.3],
}

/** The AR-from-LingBot similarity a fit should find for `frame`: p_ar = (1/s)·Rᵀ·(p_lb − t). Row-major 4x4. */
export function expectedArFromLingbot(frame: LingbotFrame): number[] {
  const rt = transposeM(frame.rotation)
  const k = 1 / frame.scale
  const t = apply3(rt, frame.translation).map((v) => -k * v)
  return [
    k * rt[0]![0]!, k * rt[0]![1]!, k * rt[0]![2]!, t[0]!,
    k * rt[1]![0]!, k * rt[1]![1]!, k * rt[1]![2]!, t[1]!,
    k * rt[2]![0]!, k * rt[2]![1]!, k * rt[2]![2]!, t[2]!,
    0, 0, 0, 1,
  ]
}

type Quat = [number, number, number, number] // x, y, z, w

function quatMul(a: Quat, b: Quat): Quat {
  const [x1, y1, z1, w1] = a
  const [x2, y2, z2, w2] = b
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ]
}

/** The same rotation `poseToMatrix` builds from a quaternion (x, y, z, w). */
function quatMatrix(q: Quat): Mat3 {
  const [x, y, z, w] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

export interface CapturedRoomOptions {
  /** The room in the AR frame, Y up: x in [0, width], z in [0, depth], floor at y = 0. Defaults to ROOM. */
  room?: { width: number; depth: number; height: number }
  /** How LingBot's frame sits against the AR one. Defaults to LINGBOT_TILTED. */
  frame?: LingbotFrame
  /** Keyframes. Default 8. */
  frames?: number
  /** 'loop' walks round the middle of the room; 'line' walks down its depth, as along a hallway. Default 'loop'. */
  path?: 'loop' | 'line'
  /** Which files to write into `dir`. All three by default. */
  write?: { cloud?: boolean; poses?: boolean; keyframes?: boolean }
  /** Keyframe records with no AR pose, as a photo or video ingest writes them. */
  noArPoses?: boolean
}

/**
 * Write a captured room into `dir`: `lingbot-map.point-cloud.ply` (the room in LingBot's frame), `lingbot-map.poses.json`
 * (each keyframe's camera in LingBot's frame, as the LingBot worker writes it: an OpenCV world-to-camera under
 * `cameraToWorld`) and `keyframes.jsonl` (the same keyframes' AR poses: metric, Y up, OpenGL camera axes).
 */
export async function writeCapturedRoom(dir: string, opts: CapturedRoomOptions = {}): Promise<{ points: number }> {
  const room = opts.room ?? ROOM
  const frame = opts.frame ?? LINGBOT_TILTED
  const n = opts.frames ?? 8
  const write = { cloud: true, poses: true, keyframes: true, ...opts.write }
  const toLingbot = (p: Vec3): Vec3 => {
    const r = apply3(frame.rotation, p)
    return [frame.scale * r[0] + frame.translation[0], frame.scale * r[1] + frame.translation[1], frame.scale * r[2] + frame.translation[2]]
  }

  // The cameras: about 1.4 m up, looking a little down, turning as they go.
  const poseLines: string[] = []
  const lingbotFrames: Array<{ file: string; cameraToWorld: number[][] }> = []
  for (let k = 0; k < n; k++) {
    const u = k / n
    const position: Vec3 = opts.path === 'line'
      ? [room.width / 2 + 0.05 * Math.sin(7 * k), 1.4, 0.5 + (room.depth - 1) * (k / Math.max(1, n - 1))]
      : [room.width / 2 + 0.3 * room.width * Math.cos(2 * Math.PI * u), 1.4, room.depth / 2 + 0.3 * room.depth * Math.sin(2 * Math.PI * u)]
    const yaw = opts.path === 'line' ? Math.PI + 0.6 * Math.sin(3 * k) : 2 * Math.PI * u
    const pitch = -0.15 - 0.05 * Math.cos(5 * k)
    const q = quatMul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)])
    const file = `kf-${String(k).padStart(5, '0')}.jpg`
    poseLines.push(JSON.stringify({
      index: k,
      file,
      ...(opts.noArPoses ? {} : {
        pose: {
          position: { x: position[0], y: position[1], z: position[2] },
          rotation: { x: q[0], y: q[1], z: q[2], w: q[3] },
        },
      }),
    }))
    // The same camera in LingBot's frame (OpenGL axes), then as LingBot writes it: OpenCV world-to-camera.
    const rLb = mul3(frame.rotation, quatMatrix(q))
    const cLb = toLingbot(position)
    const rCv = rLb.map((row) => [row[0]!, -row[1]!, -row[2]!])
    const w = transposeM(rCv)
    const t = apply3(w, cLb).map((v) => -v)
    lingbotFrames.push({ file, cameraToWorld: [[...w[0]!, t[0]!], [...w[1]!, t[1]!], [...w[2]!, t[2]!]] })
  }
  if (write.keyframes) await fs.writeFile(`${dir}/keyframes.jsonl`, poseLines.join('\n') + '\n')
  if (write.poses) await fs.writeFile(`${dir}/lingbot-map.poses.json`, JSON.stringify({ frames: lingbotFrames }))
  if (!write.cloud) return { points: 0 }

  // The room's surfaces, with a little sensor-like jitter, in the AR frame, then carried into LingBot's.
  const rand = mulberry32(4321)
  const gauss = (sigma: number) => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand()) * sigma
  const pts: Vec3[] = []
  const perArea = 1000
  const planeN = Math.round(room.width * room.depth * perArea)
  for (const y of [0, room.height]) {
    for (let i = 0; i < planeN; i++) pts.push([rand() * room.width, y + gauss(0.005), rand() * room.depth])
  }
  for (const x of [0, room.width]) {
    for (let i = 0; i < Math.round(room.depth * room.height * perArea); i++) {
      pts.push([x + gauss(0.008), rand() * room.height, rand() * room.depth])
    }
  }
  for (const z of [0, room.depth]) {
    for (let i = 0; i < Math.round(room.width * room.height * perArea); i++) {
      pts.push([rand() * room.width, rand() * room.height, z + gauss(0.008)])
    }
  }
  const header = new TextEncoder().encode(
    'ply\nformat binary_little_endian 1.0\n' + `element vertex ${pts.length}\n` +
      'property float x\nproperty float y\nproperty float z\n' +
      'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n',
  )
  const body = new Uint8Array(pts.length * 15)
  const view = new DataView(body.buffer)
  pts.forEach((p, i) => {
    const q = toLingbot(p)
    view.setFloat32(i * 15, q[0], true)
    view.setFloat32(i * 15 + 4, q[1], true)
    view.setFloat32(i * 15 + 8, q[2], true)
    body.fill(128, i * 15 + 12, i * 15 + 15)
  })
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  await fs.writeFile(`${dir}/lingbot-map.point-cloud.ply`, out)
  return { points: pts.length }
}
