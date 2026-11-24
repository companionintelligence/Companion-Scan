/**
 * Poses and intrinsics: what the frame set's views are placed with. The bug
 * this replaces read `v.matrix`, which no frame set carried, so every view was
 * trained at the identity; and it assumed a 60° lens for every camera.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cameraToMatrix,
  columnMajorToRows,
  frameIntrinsics,
  mul4,
  poseToMatrix,
  readIntrinsics,
  samplePoseTrack,
  trackIntrinsics,
} from '../stages/pose.mjs'
import { readJpegDimensions } from '../stages/extract.mjs'
import { tinyJpeg } from './helpers.mjs'

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

const track = {
  durationMs: 1000,
  intrinsics: { width: 1080, height: 1920, fovYDeg: 48, aspect: 0.5625 },
  frames: [
    { timestamp: 0, pose: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } },
    // 90° about Y.
    { timestamp: 1000, pose: { position: { x: 2, y: 1, z: 0 }, rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } } },
  ],
}

test('the track is sampled at the timestep, between its samples', () => {
  const mid = samplePoseTrack(track, 500)
  close(mid.position.x, 1)
  // Halfway through a 90° turn is 45°: y = sin(22.5°), w = cos(22.5°).
  close(mid.rotation.y, Math.sin(Math.PI / 8), 1e-6)
  close(mid.rotation.w, Math.cos(Math.PI / 8), 1e-6)
  assert.equal(samplePoseTrack(track, -50).position.x, 0, 'held at the first sample')
  assert.equal(samplePoseTrack(track, 5000), null, 'a time far from every sample has no pose')
  assert.equal(samplePoseTrack({ frames: [] }, 0), null)
})

test('a pose becomes an unflipped camera-to-world matrix', () => {
  const m = poseToMatrix(track.frames[1].pose)
  close(m[0][3], 2)
  close(m[1][3], 1)
  // +90° about Y maps camera +X to world -Z.
  close(m[2][0], -1, 1e-12)
  assert.deepEqual(poseToMatrix({}), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
})

test('localToWorld (column-major) carries a session pose into the Place frame', () => {
  // A translation of (10, 0, -3), column-major as three.js and ScanManifest store it.
  const l2w = columnMajorToRows([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, -3, 1])
  const placed = mul4(l2w, poseToMatrix(track.frames[0].pose))
  close(placed[0][3], 10)
  close(placed[1][3], 1)
  close(placed[2][3], -3)
  assert.equal(columnMajorToRows([1, 2, 3]), null)
})

test('a 4DAnyone camera is read in each accepted shape, and refused otherwise', () => {
  const rows = [[1, 0, 0, 1], [0, 1, 0, 2], [0, 0, 1, 3], [0, 0, 0, 1]]
  assert.deepEqual(cameraToMatrix(rows), rows)
  assert.deepEqual(cameraToMatrix(rows.flat()), rows)
  assert.deepEqual(cameraToMatrix({ transform_matrix: rows }), rows)
  assert.deepEqual(cameraToMatrix({ c2w: rows.flat() }), rows)
  close(cameraToMatrix({ position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } })[0][3], 4)
  assert.equal(cameraToMatrix({ yaw: 30 }), null)
  assert.equal(cameraToMatrix(null), null)
})

test('intrinsics come from the track or the camera record, never a fixed 60°', () => {
  assert.deepEqual(trackIntrinsics(track, 10), { fovYDeg: 48, width: 1080, height: 1920 })
  // A frame's own intrinsics beat the track header.
  const perFrame = { ...track, frames: [{ ...track.frames[0], intrinsics: { fovYDeg: 40 } }] }
  assert.equal(trackIntrinsics(perFrame, 0).fovYDeg, 40)
  assert.equal(readIntrinsics({ fx: 900, fy: 905, cx: 540, cy: 960, width: 1080, height: 1920 }).fy, 905)
  assert.equal(readIntrinsics({ note: 'nothing here' }), null)
  assert.equal(trackIntrinsics({ frames: [], intrinsics: null }, 0), null)
})

test('intrinsics are scaled to the pixels that landed', () => {
  const fov = frameIntrinsics({ fovYDeg: 90 }, 720, 1280)
  close(fov.fl_y, 640)
  assert.equal(fov.cx, 360)
  // fx/fy recorded at 1080x1920, frame extracted at 540x960: half.
  const px = frameIntrinsics({ fx: 1000, fy: 1000, cx: 540, cy: 960, width: 1080, height: 1920 }, 540, 960)
  assert.deepEqual([px.fl_x, px.fl_y, px.cx, px.cy, px.w, px.h], [500, 500, 270, 480, 540, 960])
})

test('the JPEG reader finds the real dimensions', () => {
  assert.deepEqual(readJpegDimensions(tinyJpeg(720, 1280)), { w: 720, h: 1280 })
  assert.equal(readJpegDimensions(Buffer.from('not a jpeg')), null)
})
