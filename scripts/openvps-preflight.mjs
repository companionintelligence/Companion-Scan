/** Read-only structural preflight of a local Place photo reference for an OpenVPS pilot. */
import { lstat, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { readFrameSize } from '../server/colmap/colmap_joint.ts'
import { parseCamerasBin, parseImagesBin, parsePoints3DBin } from '../server/colmap/colmap_model.ts'
import { DEFAULT_MIN_POINTS_3D, DEFAULT_MIN_REGISTRATION_RATIO, KEYFRAME_RE } from '../server/colmap/colmap_poses.ts'
import { isNotFound } from '../server/fs_util.ts'
import { SFM_MIN_REGISTERED_IMAGES } from '../server/register/place_register_sfm.ts'
import { CACHE_SCHEMA_VERSION, referenceCacheDir } from '../server/register/sfm_workspace.ts'
import { isServerSessionId } from '../src/shared/session-id.ts'

const usage = 'Usage: node scripts/openvps-preflight.mjs <session-directory>'

async function isFile(path) {
  return (await lstat(path).catch((error) => {
    if (!isNotFound(error)) throw error
  }))?.isFile() ?? false
}

async function preflight(sessionDir) {
  const sessionId = basename(sessionDir)
  if (!isServerSessionId(sessionId) || !(await lstat(sessionDir)).isDirectory() ||
      !(await isFile(join(sessionDir, 'session.json')))) {
    return { status: 'blocked', issues: ['invalid-session'] }
  }

  const cache = referenceCacheDir(sessionDir)
  const model = join(cache, 'sparse')
  const reference = join(cache, 'reference.json')
  if (!(await lstat(cache)).isDirectory() || !(await lstat(model)).isDirectory() || !(await isFile(reference))) {
    return { status: 'blocked', issues: ['invalid-reference-cache'] }
  }

  const manifest = JSON.parse(await readFile(reference, 'utf8'))
  if (manifest?.kind !== 'place-register-sfm-reference' || manifest.schemaVersion !== CACHE_SCHEMA_VERSION ||
      manifest.sessionId !== sessionId || typeof manifest.projectId !== 'string' || !manifest.projectId ||
      typeof manifest.scanId !== 'string' || !manifest.scanId || !Number.isSafeInteger(manifest.epoch) || manifest.epoch < 0 ||
      typeof manifest.frameFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.frameFingerprint) ||
      !Number.isSafeInteger(manifest.frameCount) || manifest.frameCount < 1 ||
      !Number.isSafeInteger(manifest.registeredImages) || manifest.registeredImages < 0 ||
      manifest.registeredImages > manifest.frameCount) {
    return { status: 'blocked', issues: ['invalid-reference-manifest'] }
  }

  const issues = []
  if (typeof manifest.frameId !== 'string' || !manifest.frameId.trim()) issues.push('missing-place-frame-generation')
  const modelFiles = ['cameras.bin', 'images.bin', 'points3D.bin'].map((name) => join(model, name))
  if (!(await Promise.all(modelFiles.map(isFile))).every(Boolean)) {
    return { status: 'blocked', issues: [...issues, 'missing-sparse-model-files'] }
  }

  const [cameraBytes, imageBytes, pointBytes] = await Promise.all(modelFiles.map((path) => readFile(path)))
  const cameraRows = parseCamerasBin(cameraBytes)
  const cameras = new Map(cameraRows.map((camera) => [camera.cameraId, camera]))
  if (cameras.size === 0 || BigInt(cameras.size) !== cameraBytes.readBigUInt64LE()) issues.push('unusable-camera-table')
  const images = parseImagesBin(imageBytes)
  const points = parsePoints3DBin(pointBytes)
  const registeredImages = images.length
  const registrationRatio = registeredImages / manifest.frameCount
  if (registeredImages !== manifest.registeredImages) issues.push('reference-image-count-mismatch')
  if (registeredImages < SFM_MIN_REGISTERED_IMAGES || registrationRatio < DEFAULT_MIN_REGISTRATION_RATIO) {
    issues.push('too-few-registered-images')
  }
  if (points.length < DEFAULT_MIN_POINTS_3D) issues.push('too-few-sparse-points')

  const names = new Set()
  let usableImages = 0
  for (const image of images) {
    const filename = image.name.slice(sessionId.length + 1)
    const camera = cameras.get(image.cameraId)
    if (!image.name.startsWith(`${sessionId}/`) || !KEYFRAME_RE.test(filename) || names.has(filename) ||
        !camera || ![camera.fx, camera.fy, camera.cx, camera.cy, ...image.qvec, ...image.tvec].every(Number.isFinite) ||
        camera.fx <= 0 || camera.fy <= 0 || Math.abs(Math.hypot(...image.qvec) - 1) > 0.001) continue
    names.add(filename)
    const frame = join(sessionDir, filename)
    const size = (await isFile(frame)) ? await readFrameSize(frame) : null
    if (size?.width === camera.width && size?.height === camera.height) usableImages++
  }
  if (usableImages !== registeredImages) issues.push('unusable-registered-images')

  return {
    status: issues.length ? 'blocked' : 'candidate',
    offeredImages: manifest.frameCount,
    registeredImages,
    usableImages,
    sparsePoints: points.length,
    issues,
  }
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log(usage)
} else if (args.length !== 1 || args[0].startsWith('-')) {
  console.error(usage)
  process.exitCode = 2
} else {
  // Filesystem errors can contain private names and paths. Print reason codes only.
  const result = await preflight(resolve(args[0])).catch((error) => ({
    status: 'blocked',
    issues: [isNotFound(error) ? 'session-or-reference-missing' : 'unreadable-session-or-reference'],
  }))
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'candidate') process.exitCode = 1
}
