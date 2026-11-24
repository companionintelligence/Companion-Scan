/**
 * Stage 2 — the contract.
 *
 * A **posed multi-view frame set** is one instant, seen from N cameras, with a
 * pose for each. It is what both capture paths converge on:
 *
 *   1 clip  → 4DAnyone synthesizes the views a camera array would have seen
 *   N clips → the real cameras already provide them
 *
 * and it is exactly the shape `server/splat/splat_train_dataset.ts` already
 * builds for Brush. Nothing downstream knows which path produced it, which is
 * what makes the densifier swappable — and what would let a deformable 4DGS
 * trainer replace the per-timestep step later without touching capture or
 * playback.
 *
 * Pure: this module plans the slicing. Extraction is the caller's job.
 */

/**
 * Timesteps to slice from a clip.
 *
 * Deliberately *not* every source frame. A 121-frame clip at 25fps is ~4.8s;
 * at the default 5fps that is ~24 timesteps, and each timestep costs a full
 * splat train. Sequence length is the pipeline's whole cost budget.
 */
export function planTimesteps({ durationMs, timestepFps, startMs = 0 }) {
  if (!(durationMs > 0) || !(timestepFps > 0)) return []
  const count = Math.max(1, Math.floor((durationMs / 1000) * timestepFps))
  const stepMs = durationMs / count
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    // Sample the middle of each interval rather than its edge: the first and
    // last frames of a clip are the most likely to be motion-blurred or to
    // catch the subject still settling.
    timeMs: Math.round(startMs + stepMs * (i + 0.5)),
  }))
}

/**
 * The span every view can be sliced over, in take time. A view samples its
 * clip at `t + offsetMs`, so it covers `[-offsetMs, durationMs - offsetMs]`;
 * the take covers what every view does. `durationMs` 0 when they do not overlap.
 */
export function commonWindow(views) {
  let startMs = 0
  let endMs = Infinity
  for (const v of views) {
    const offset = v.offsetMs ?? 0
    startMs = Math.max(startMs, -offset)
    endMs = Math.min(endMs, (v.durationMs ?? 0) - offset)
  }
  if (!Number.isFinite(endMs)) return { startMs: 0, durationMs: 0 }
  return { startMs, durationMs: Math.max(0, endMs - startMs) }
}

/**
 * Build the frame-set plan for a take.
 *
 * `views` is the list of sources contributing to every timestep — synthesized
 * view videos on the densify path, real clips on the multi-camera path. The
 * result is one entry per timestep, each naming every view to extract.
 */
export function planFrameSets({ views, durationMs, timestepFps, startMs = 0 }) {
  const timesteps = planTimesteps({ durationMs, timestepFps, startMs })
  return timesteps.map(t => ({
    index: t.index,
    timeMs: t.timeMs,
    views: views.map((v, viewIndex) => ({
      viewIndex,
      source: v.source,
      pose: v.pose ?? null,
      intrinsics: v.intrinsics ?? null,
      timeMs: t.timeMs + (v.offsetMs ?? 0),
    })),
  }))
}

/**
 * Decide which path a take takes.
 *
 * The interesting case is the third one. A multi-clip take whose members never
 * measured each other cannot be sliced as simultaneous — the frames would come
 * from different instants and be fed to the trainer as if they were one, which
 * produces a smeared reconstruction with no error anywhere. Densifying from the
 * single best clip is worse in principle and better in practice, and either way
 * the decision is recorded rather than made silently.
 */
export function choosePath(clips) {
  if (clips.length <= 1) {
    return { viewSource: 'densified', reason: 'single clip — 4DAnyone stands in for the missing cameras', members: [] }
  }
  const measured = clips.filter(c => c.sync && c.sync.method === 'measured')
  if (measured.length < 2) {
    return {
      viewSource: 'densified',
      reason: `${clips.length} clips but only ${measured.length} carry a measured sync — slicing them as simultaneous would mix instants, so the best single clip is densified instead`,
      degraded: true,
      members: [],
    }
  }
  const worst = Math.max(...measured.map(c => c.sync.residualMs ?? 0))
  const tolerance = Math.min(...measured.map(c => c.sync.toleranceMs ?? Infinity))
  if (worst > tolerance) {
    return {
      viewSource: 'densified',
      reason: `inter-member residual ${worst}ms exceeds the ${tolerance}ms tolerance — densifying the best clip rather than mixing instants`,
      degraded: true,
      members: [],
    }
  }
  // A real camera is a view only when it can be placed: a pose track, and the
  // member's session-to-Place transform. Pose-track poses are in each phone's
  // own session frame; only `localToWorld` puts N of them in one frame.
  const placed = measured.filter(c => hasPoseTrack(c) && isMatrix16(c.localToWorld))
  if (placed.length < 2) {
    const unposed = measured.filter(c => !hasPoseTrack(c)).length
    const unplaced = measured.filter(c => hasPoseTrack(c) && !isMatrix16(c.localToWorld)).length
    return {
      viewSource: 'densified',
      reason: `${measured.length} synchronised clips, but only ${placed.length} can be placed (${unposed} without a pose track, ${unplaced} without a session-to-Place transform) — densifying the best clip instead`,
      degraded: true,
      members: [],
    }
  }
  const left = clips.length - placed.length
  return {
    viewSource: 'multi-camera',
    reason: `${placed.length} synchronised, placed cameras — 4DAnyone not needed` +
      (left > 0 ? ` (${left} clip(s) left out: unsynced, unposed or unplaced)` : ''),
    members: placed,
  }
}

/** A clip whose pose track has samples, or (before download) that names one. */
function hasPoseTrack(c) {
  if (c.poseTrack !== undefined) return Array.isArray(c.poseTrack?.frames) && c.poseTrack.frames.length > 0
  return Boolean(c.poseTrackUrl)
}

function isMatrix16(m) {
  return Array.isArray(m) && m.length === 16 && m.every(v => typeof v === 'number' && Number.isFinite(v))
}

/**
 * Pick the clip to densify when the multi-camera path is unavailable.
 *
 * Prefers a clip with a pose track (its camera path is known, which helps the
 * downstream train), then the longest.
 */
export function bestClip(clips) {
  if (clips.length === 0) return null
  const withPose = clips.filter(c => hasPoseTrack(c))
  const pool = withPose.length > 0 ? withPose : clips
  return pool.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a))
}
