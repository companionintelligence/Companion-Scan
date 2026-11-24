/**
 * The messages between the page and the marker-reading worker (`tag-worker.ts`, driven by `tag-worker-client.ts`).
 *
 * Types only, no values, so the page, the worker and the tests all import them without importing each other. Everything in a
 * message survives structured cloning: numbers, strings, arrays, plain objects, and the frame's bytes as an `ArrayBuffer`,
 * which the page TRANSFERS (moves, without a copy) and so can no longer read after it has sent it.
 */
import type { DetectorOptions, DetectorStats } from './detector.ts'
import type { RoiRect } from './tag-runner.ts'
import type { FiducialDetection } from './types.ts'

/** First message, once: which family to read (by `Dictionary.name`, a dictionary cannot be cloned) and how. */
export interface TagWorkerInit {
  type: 'init'
  family: string
  detector: DetectorOptions
  /** Search around the last tag found. */
  roi: boolean
}

/** Forget where the tag was. */
export interface TagWorkerReset {
  type: 'reset'
}

/** One camera frame. `buffer` is transferred. */
export interface TagWorkerFrame {
  type: 'frame'
  /** The page's count of this frame, echoed in the answer. */
  seq: number
  buffer: ArrayBuffer
  width: number
  height: number
  rowBytes: number
  channels: 1 | 4
}

export type TagWorkerRequest = TagWorkerInit | TagWorkerReset | TagWorkerFrame

/** The worker is ready for frames. */
export interface TagWorkerReady {
  type: 'ready'
}

/** The answer to one frame. */
export interface TagWorkerResult {
  type: 'result'
  seq: number
  detections: FiducialDetection[]
  stats: DetectorStats
  roi: RoiRect | null
  roiMissed: boolean
  passes: number
  /** Milliseconds in the detector, all passes. */
  detectMs: number
  /** Milliseconds from the worker's receipt of the frame to its answer. */
  workerMs: number
}

/** Something the worker could not do. `seq` is the frame it was doing, if any. */
export interface TagWorkerError {
  type: 'error'
  seq: number | null
  message: string
}

export type TagWorkerResponse = TagWorkerReady | TagWorkerResult | TagWorkerError
