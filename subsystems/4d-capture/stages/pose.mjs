/**
 * Camera poses and intrinsics for a frame set.
 *
 * Two sources:
 *
 *  - **A pose track** (the multi-camera path). Companion Scan records one beside
 *    every person clip (`src/capture/pose-track.ts`): `frames[]` of
 *    `{ timestamp, pose: { position, rotation } }`, timestamps in ms since the
 *    recording started, on the clock the clip is stamped with, plus
 *    `intrinsics: { width, height, fovYDeg, aspect }`. The phone moves, so a
 *    timestep's pose is the track sampled at that timestep's time. The poses are
 *    in the device's own session frame; a clip's `localToWorld` (the member
 *    scan's column-major session-to-Place matrix) carries them into the Place
 *    frame every member shares.
 *  - **4DAnyone's cameras.json** (the densify path). Its exact shape is not
 *    verified against a real run (README, "Confidence levels"), so three shapes
 *    are accepted and anything else is refused by name rather than trained as
 *    an identity pose.
 *
 * No axis flip anywhere: Companion Scan poses are OpenGL camera-to-world, which
 * is what Nerfstudio wants. `poseToMatrix` is the same function as the
 * appliance's (server/splat/splat_train_dataset.ts), and a parity test holds
 * the two equal.
 */

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Row-major 4x4 camera-to-world from `{ position, rotation }` (a quaternion). */
export function poseToMatrix(pose) {
  const p = pose?.position ?? {}
  const q = pose?.rotation ?? {}
  const px = num(p.x, 0)
  const py = num(p.y, 0)
  const pz = num(p.z, 0)
  let qx = num(q.x, 0)
  let qy = num(q.y, 0)
  let qz = num(q.z, 0)
  let qw = num(q.w, 1)
  const n = Math.hypot(qx, qy, qz, qw) || 1
  qx /= n
  qy /= n
  qz /= n
  qw /= n
  const xx = qx * qx, yy = qy * qy, zz = qz * qz
  const xy = qx * qy, xz = qx * qz, yz = qy * qz
  const wx = qw * qx, wy = qw * qy, wz = qw * qz
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), px],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), py],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), pz],
    [0, 0, 0, 1],
  ]
}

/** Spherical interpolation between two unit quaternions, taking the short way round. */
function slerp(a, b, t) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw
    dot = -dot
  }
  if (dot > 0.9995) {
    const out = { x: a.x + t * (bx - a.x), y: a.y + t * (by - a.y), z: a.z + t * (bz - a.z), w: a.w + t * (bw - a.w) }
    const n = Math.hypot(out.x, out.y, out.z, out.w) || 1
    return { x: out.x / n, y: out.y / n, z: out.z / n, w: out.w / n }
  }
  const theta = Math.acos(Math.min(1, dot))
  const s = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / s
  const wb = Math.sin(t * theta) / s
  return { x: wa * a.x + wb * bx, y: wa * a.y + wb * by, z: wa * a.z + wb * bz, w: wa * a.w + wb * bw }
}

function unitQuat(q) {
  const x = num(q?.x, 0), y = num(q?.y, 0), z = num(q?.z, 0), w = num(q?.w, 1)
  const n = Math.hypot(x, y, z, w) || 1
  return { x: x / n, y: y / n, z: z / n, w: w / n }
}

/** The usable samples of a pose track, in time order. */
export function trackSamples(track) {
  const frames = Array.isArray(track?.frames) ? track.frames : []
  return frames
    .filter((f) => Number.isFinite(f?.timestamp) && f?.pose && typeof f.pose === 'object')
    .sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * The pose at `timeMs`, interpolated between the samples either side
 * (position linearly, rotation by slerp), held at the ends. Null when the
 * track has no samples. `withinMs` refuses a time further than that from every
 * sample, so a gap in the track is not papered over.
 */
export function samplePoseTrack(track, timeMs, { withinMs = 500 } = {}) {
  const samples = trackSamples(track)
  if (samples.length === 0) return null
  if (timeMs <= samples[0].timestamp) {
    return samples[0].timestamp - timeMs <= withinMs ? samples[0].pose : null
  }
  const last = samples[samples.length - 1]
  if (timeMs >= last.timestamp) {
    return timeMs - last.timestamp <= withinMs ? last.pose : null
  }
  const hi = samples.findIndex((s) => s.timestamp >= timeMs)
  const a = samples[hi - 1]
  const b = samples[hi]
  if (timeMs - a.timestamp > withinMs && b.timestamp - timeMs > withinMs) return null
  const span = b.timestamp - a.timestamp
  const t = span > 0 ? (timeMs - a.timestamp) / span : 0
  const pa = a.pose.position ?? {}
  const pb = b.pose.position ?? {}
  return {
    position: {
      x: num(pa.x, 0) + t * (num(pb.x, 0) - num(pa.x, 0)),
      y: num(pa.y, 0) + t * (num(pb.y, 0) - num(pa.y, 0)),
      z: num(pa.z, 0) + t * (num(pb.z, 0) - num(pa.z, 0)),
    },
    rotation: slerp(unitQuat(a.pose.rotation), unitQuat(b.pose.rotation), t),
  }
}

/** The track sample nearest `timeMs`, for its per-frame intrinsics. */
function nearestSample(track, timeMs) {
  let best = null
  for (const s of trackSamples(track)) {
    if (!best || Math.abs(s.timestamp - timeMs) < Math.abs(best.timestamp - timeMs)) best = s
  }
  return best
}

/** Row-major 4x4 multiply. */
export function mul4(a, b) {
  const out = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[r][k] * b[k][c]
      out[r][c] = s
    }
  }
  return out
}

/** A column-major 16-number matrix (three.js, `ScanManifest.localToWorld`) as row-major 4x4, or null. */
export function columnMajorToRows(m) {
  if (!Array.isArray(m) || m.length !== 16 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ]
}

function rows4(m) {
  if (!Array.isArray(m) || m.length !== 4) return null
  const rows = m.map((r) => (Array.isArray(r) && r.length >= 4 ? r.slice(0, 4).map(Number) : null))
  return rows.every((r) => r && r.every(Number.isFinite)) ? rows : null
}

/**
 * A 4DAnyone camera as a row-major camera-to-world matrix, or null. Accepted:
 * a 4x4 array, a flat 16 (row-major), `{ position, rotation }`, or an object
 * holding one of those under `transform_matrix`, `c2w` or `matrix`.
 */
export function cameraToMatrix(cam) {
  if (!cam) return null
  const asRows = rows4(cam)
  if (asRows) return asRows
  if (Array.isArray(cam) && cam.length === 16 && cam.every(Number.isFinite)) {
    return [cam.slice(0, 4), cam.slice(4, 8), cam.slice(8, 12), cam.slice(12, 16)]
  }
  if (typeof cam === 'object') {
    for (const key of ['transform_matrix', 'c2w', 'matrix']) {
      if (cam[key] !== undefined) return cameraToMatrix(cam[key])
    }
    if (cam.position && cam.rotation) return poseToMatrix(cam)
  }
  return null
}

/**
 * Intrinsics from a record that may carry them: `fx`/`fy` (and `cx`/`cy`) in
 * pixels of `width` x `height`, or a vertical field of view (`fovYDeg`, `fovy`,
 * `fov_y`, in degrees). Null when it carries neither.
 */
export function readIntrinsics(rec) {
  if (!rec || typeof rec !== 'object') return null
  const width = num(rec.width ?? rec.w, undefined)
  const height = num(rec.height ?? rec.h, undefined)
  const fx = num(rec.fx ?? rec.fl_x, undefined)
  const fy = num(rec.fy ?? rec.fl_y, undefined)
  const fovYDeg = num(rec.fovYDeg ?? rec.fovy ?? rec.fov_y, undefined)
  if ((fx > 0 || fy > 0) && width > 0 && height > 0) {
    return { width, height, fx: fx ?? fy, fy: fy ?? fx, cx: num(rec.cx, undefined), cy: num(rec.cy, undefined) }
  }
  if (fovYDeg > 0 && fovYDeg < 180) return { fovYDeg, ...(width > 0 ? { width } : {}), ...(height > 0 ? { height } : {}) }
  return null
}

/** Intrinsics for one pose-track view at `timeMs`: the nearest frame's own, else the track's. */
export function trackIntrinsics(track, timeMs) {
  return readIntrinsics(nearestSample(track, timeMs)?.intrinsics) ?? readIntrinsics(track?.intrinsics)
}

/**
 * Nerfstudio per-frame intrinsics, scaled to the pixels that landed. A focal
 * length in pixels of the recorded size is scaled by the real size; a field of
 * view gives `fl_y = h / (2 tan(fovY / 2))`, with square pixels.
 */
export function frameIntrinsics(intr, w, h) {
  if (intr.fx !== undefined) {
    const sx = intr.width > 0 ? w / intr.width : 1
    const sy = intr.height > 0 ? h / intr.height : 1
    return {
      fl_x: intr.fx * sx,
      fl_y: intr.fy * sy,
      cx: intr.cx !== undefined ? intr.cx * sx : w / 2,
      cy: intr.cy !== undefined ? intr.cy * sy : h / 2,
      w,
      h,
    }
  }
  const flY = h / (2 * Math.tan((intr.fovYDeg * Math.PI) / 180 / 2))
  return { fl_x: flY, fl_y: flY, cx: w / 2, cy: h / 2, w, h }
}
