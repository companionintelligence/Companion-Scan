using System;

namespace AuraScanner.Core
{
    /// Decides when a keyframe is worth sending: at most one per MinIntervalSeconds, and then only when the wearer has moved
    /// or turned enough, or when MaxIntervalSeconds has passed. The defaults are the web client's (1.2 s, 0.30 m, 20 degrees,
    /// src/capture/keyframes.ts), and there is no maximum interval by default, as the web client has none. Pure: no engine
    /// types, so the test harness checks it.
    public sealed class KeyframeSchedule
    {
        private readonly float _minInterval;
        private readonly float _maxInterval;
        private readonly float _minMove;
        private readonly float _minTurnDegrees;
        private bool _hasLast;
        private float _lastTime;
        private PoseF _last;

        public KeyframeSchedule(float minIntervalSeconds = 1.2f, float maxIntervalSeconds = float.PositiveInfinity,
                                float minMoveMetres = 0.30f, float minTurnDegrees = 20f)
        {
            if (minIntervalSeconds < 0f) throw new ArgumentOutOfRangeException(nameof(minIntervalSeconds));
            if (maxIntervalSeconds < minIntervalSeconds) throw new ArgumentOutOfRangeException(nameof(maxIntervalSeconds));
            if (minMoveMetres < 0f) throw new ArgumentOutOfRangeException(nameof(minMoveMetres));
            if (minTurnDegrees < 0f) throw new ArgumentOutOfRangeException(nameof(minTurnDegrees));
            _minInterval = minIntervalSeconds;
            _maxInterval = maxIntervalSeconds;
            _minMove = minMoveMetres;
            _minTurnDegrees = minTurnDegrees;
        }

        /// Whether to capture a frame at `time` (seconds on a monotonic clock) with `pose`. When it returns true, the frame
        /// is remembered as the last one. A caller that fails to capture should call Reset.
        public bool ShouldCapture(float time, PoseF pose)
        {
            if (!_hasLast) return Record(time, pose);
            float elapsed = time - _lastTime;
            if (elapsed < _minInterval) return false;
            if (elapsed >= _maxInterval) return Record(time, pose);
            if (DistanceMetres(pose, _last) >= _minMove || AngleDegrees(pose, _last) >= _minTurnDegrees)
            {
                return Record(time, pose);
            }
            return false;
        }

        /// Forgets the last frame, so the next call captures. Call at the start of each session.
        public void Reset()
        {
            _hasLast = false;
        }

        private bool Record(float time, PoseF pose)
        {
            _hasLast = true;
            _lastTime = time;
            _last = pose;
            return true;
        }

        public static float DistanceMetres(PoseF a, PoseF b)
        {
            float dx = a.X - b.X;
            float dy = a.Y - b.Y;
            float dz = a.Z - b.Z;
            return (float)Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        /// The angle between two orientations in degrees. The sign of a quaternion does not matter (q and -q are one
        /// rotation), so the scalar part is taken in absolute value.
        public static float AngleDegrees(PoseF a, PoseF b)
        {
            // The relative rotation conj(a) * b has scalar part dot(a, b) and vector part v. The angle is 2 * atan2(|v|, |scalar|),
            // which stays accurate near zero, where 2 * acos(dot) does not (src/shared/pose-math.ts makes the same point).
            double ax = a.Qx, ay = a.Qy, az = a.Qz, aw = a.Qw;
            double bx = b.Qx, by = b.Qy, bz = b.Qz, bw = b.Qw;
            double scalar = aw * bw + ax * bx + ay * by + az * bz;
            double vx = aw * bx - bw * ax - (ay * bz - az * by);
            double vy = aw * by - bw * ay - (az * bx - ax * bz);
            double vz = aw * bz - bw * az - (ax * by - ay * bx);
            double vector = Math.Sqrt(vx * vx + vy * vy + vz * vz);
            return (float)(2.0 * Math.Atan2(vector, Math.Abs(scalar)) * 180.0 / Math.PI);
        }
    }
}
