using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using AuraScanner.Core;

namespace AuraScanner.CoreHarness
{
    /// Checks the engine-free Core that the Unity scanner ships: pose conversion, the keyframe trigger, the record JSON,
    /// the upload retry rule and frame orientation. Run from the repository root with:
    ///   dotnet run --project unity/aura-scanner/Tests/CoreHarness
    /// The exit code is 0 when every check passes.
    internal static class Program
    {
        private static int _checks;
        private static readonly List<string> Failures = new List<string>();

        private static int Main()
        {
            PoseConventionChecks();
            KeyframeScheduleChecks();
            KeyframeRecordChecks();
            UploadPolicyChecks();
            FrameOrientationChecks();

            Console.WriteLine(_checks + " checks, " + Failures.Count + " failed");
            foreach (string failure in Failures)
            {
                Console.WriteLine("FAIL: " + failure);
            }
            return Failures.Count == 0 ? 0 : 1;
        }

        private static void Check(bool condition, string what)
        {
            _checks++;
            if (!condition) Failures.Add(what);
        }

        private static bool Near(double a, double b, double tolerance = 1e-4)
        {
            return Math.Abs(a - b) <= tolerance;
        }

        private static bool Throws<T>(Action action) where T : Exception
        {
            try
            {
                action();
                return false;
            }
            catch (Exception e)
            {
                return e is T;
            }
        }

        private static bool SameInts(int[] a, int[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i]) return false;
            }
            return true;
        }

        private static bool SamePose(PoseF a, PoseF b)
        {
            return Near(a.X, b.X, 1e-6) && Near(a.Y, b.Y, 1e-6) && Near(a.Z, b.Z, 1e-6)
                && Near(a.Qx, b.Qx, 1e-6) && Near(a.Qy, b.Qy, 1e-6) && Near(a.Qz, b.Qz, 1e-6) && Near(a.Qw, b.Qw, 1e-6);
        }

        private static double Length(double x, double y, double z, double w)
        {
            return Math.Sqrt(x * x + y * y + z * z + w * w);
        }

        // ── Pose convention ────────────────────────────────────────────────────────

        private static void PoseConventionChecks()
        {
            var pose = new PoseF(1f, 2f, 3f, 0.1f, 0.2f, 0.3f, 0.9f);
            PoseF converted = PoseConvention.ToRightHanded(pose);
            Check(Near(converted.X, 1) && Near(converted.Y, 2) && Near(converted.Z, -3), "position: Z is mirrored");
            Check(Near(converted.Qx, -0.1) && Near(converted.Qy, -0.2) && Near(converted.Qz, 0.3) && Near(converted.Qw, 0.9),
                  "rotation: x and y are negated, z and w are kept");
            Check(SamePose(PoseConvention.ToRightHanded(converted), pose), "the conversion is its own inverse");

            var random = new Random(20261124);
            for (int i = 0; i < 500; i++)
            {
                PoseF unity = RandomPose(random);
                PoseF rightHanded = PoseConvention.ToRightHanded(unity);
                Check(Near(Length(rightHanded.Qx, rightHanded.Qy, rightHanded.Qz, rightHanded.Qw), 1, 1e-5),
                      "the converted quaternion stays unit length");
                // Mirroring Unity's forward (+Z) must give the converted pose's forward (-Z).
                Vec3 unityForward = Rotate(unity, new Vec3(0, 0, 1));
                var mirrored = new Vec3(unityForward.X, unityForward.Y, -unityForward.Z);
                Check(Close(mirrored, Rotate(rightHanded, new Vec3(0, 0, -1))),
                      "a Unity forward vector, mirrored, is the converted pose's -Z forward");
            }
        }

        private static PoseF RandomPose(Random random)
        {
            double x = random.NextDouble() * 2 - 1;
            double y = random.NextDouble() * 2 - 1;
            double z = random.NextDouble() * 2 - 1;
            double w = random.NextDouble() * 2 - 1;
            double n = Length(x, y, z, w);
            return new PoseF(
                (float)(random.NextDouble() * 10 - 5),
                (float)(random.NextDouble() * 10 - 5),
                (float)(random.NextDouble() * 10 - 5),
                (float)(x / n), (float)(y / n), (float)(z / n), (float)(w / n));
        }

        private readonly struct Vec3
        {
            public readonly double X;
            public readonly double Y;
            public readonly double Z;

            public Vec3(double x, double y, double z)
            {
                X = x;
                Y = y;
                Z = z;
            }
        }

        private static bool Close(Vec3 a, Vec3 b)
        {
            return Near(a.X, b.X, 1e-5) && Near(a.Y, b.Y, 1e-5) && Near(a.Z, b.Z, 1e-5);
        }

        private static Vec3 Rotate(PoseF q, Vec3 v)
        {
            return Rotate(q.Qx, q.Qy, q.Qz, q.Qw, v);
        }

        /// v' = v + w t + q x t, with t = 2 (q x v). Written out, so the harness needs no maths library.
        private static Vec3 Rotate(double qx, double qy, double qz, double qw, Vec3 v)
        {
            double tx = 2 * (qy * v.Z - qz * v.Y);
            double ty = 2 * (qz * v.X - qx * v.Z);
            double tz = 2 * (qx * v.Y - qy * v.X);
            return new Vec3(
                v.X + qw * tx + (qy * tz - qz * ty),
                v.Y + qw * ty + (qz * tx - qx * tz),
                v.Z + qw * tz + (qx * ty - qy * tx));
        }

        // ── Keyframe trigger ───────────────────────────────────────────────────────

        private static PoseF Still()
        {
            return new PoseF(0, 0, 0, 0, 0, 0, 1);
        }

        private static PoseF At(float x, float y, float z)
        {
            return new PoseF(x, y, z, 0, 0, 0, 1);
        }

        /// A rotation of `degrees` about the vertical axis.
        private static PoseF Yaw(double degrees)
        {
            double half = degrees * Math.PI / 360.0;
            return new PoseF(0, 0, 0, 0, (float)Math.Sin(half), 0, (float)Math.Cos(half));
        }

        /// A schedule with test thresholds, primed with a capture at t = 0 while still.
        private static KeyframeSchedule Primed(float min = 0.5f, float max = 2f)
        {
            var schedule = new KeyframeSchedule(min, max, 0.05f, 5f);
            schedule.ShouldCapture(0f, Still());
            return schedule;
        }

        private static void KeyframeScheduleChecks()
        {
            Check(new KeyframeSchedule(0.5f, 2f, 0.05f, 5f).ShouldCapture(0f, Still()), "the first call captures");
            Check(!Primed().ShouldCapture(0.2f, At(0.2f, 0, 0)), "nothing is captured inside the minimum interval, even after moving");
            Check(!Primed().ShouldCapture(0.6f, At(0.01f, 0, 0)), "a move under the threshold does not capture");
            Check(Primed().ShouldCapture(0.6f, At(0.2f, 0, 0)), "a move past the threshold captures once the interval has passed");
            Check(!Primed().ShouldCapture(0.6f, Yaw(2)), "a turn under the threshold does not capture");
            Check(Primed().ShouldCapture(0.6f, Yaw(10)), "a turn past the threshold captures once the interval has passed");
            Check(!Primed().ShouldCapture(1.9f, Still()), "still, before the maximum interval: no capture");
            Check(Primed().ShouldCapture(2f, Still()), "still, at the maximum interval: captures");

            KeyframeSchedule reset = Primed();
            reset.Reset();
            Check(reset.ShouldCapture(0.1f, Still()), "Reset makes the next call capture");

            KeyframeSchedule chained = Primed();
            Check(chained.ShouldCapture(0.6f, At(0.2f, 0, 0)), "a capture at 0.6 s");
            Check(!chained.ShouldCapture(1.0f, At(0.5f, 0, 0)), "the interval counts from the last capture, not from the start");
            Check(chained.ShouldCapture(1.2f, At(0.5f, 0, 0)), "the threshold counts from the last captured pose");

            var defaults = new KeyframeSchedule();
            Check(defaults.ShouldCapture(0f, Still()), "defaults: the first call captures");
            Check(!defaults.ShouldCapture(1.1f, At(0.5f, 0, 0)), "defaults: 1.1 s is inside the 1.2 s minimum interval");
            Check(!defaults.ShouldCapture(1.3f, At(0.29f, 0, 0)), "defaults: 0.29 m is under the 0.30 m threshold");
            Check(!defaults.ShouldCapture(1.3f, Yaw(19)), "defaults: 19 degrees is under the 20 degree threshold");
            Check(defaults.ShouldCapture(1.3f, At(0.31f, 0, 0)), "defaults: 0.31 m captures");

            var noMaximum = new KeyframeSchedule();
            noMaximum.ShouldCapture(0f, Still());
            Check(!noMaximum.ShouldCapture(100f, Still()), "defaults have no maximum interval, as the web client has none");

            Check(Near(KeyframeSchedule.DistanceMetres(Still(), At(0.2f, 0, 0)), 0.2, 1e-5),
                  "distance is the straight-line metres between two positions");
            Check(Near(KeyframeSchedule.AngleDegrees(Still(), Yaw(90)), 90, 1e-3), "angle between two orientations, in degrees");
            PoseF q = Yaw(30);
            var negated = new PoseF(0, 0, 0, -q.Qx, -q.Qy, -q.Qz, -q.Qw);
            Check(Near(KeyframeSchedule.AngleDegrees(q, negated), 0, 1e-3), "q and -q are the same rotation");

            Check(Throws<ArgumentOutOfRangeException>(() => new KeyframeSchedule(-1f)), "a negative minimum interval is refused");
            Check(Throws<ArgumentOutOfRangeException>(() => new KeyframeSchedule(2f, 1f)), "a maximum below the minimum is refused");
        }

        // ── Keyframe record ────────────────────────────────────────────────────────

        private static void KeyframeRecordChecks()
        {
            var pose = new PoseF(1.5f, 0.25f, -2f, 0f, 0.5f, 0f, 0.8660254f);
            var intrinsics = new FrameIntrinsics
            {
                FovYDeg = 60f,
                Aspect = 16f / 9f,
                Width = 1280,
                Height = 720,
                SourceWidth = 1280,
                SourceHeight = 720,
            };

            string json = KeyframeRecord.ToJson(7, 12345.5, 1700000000123, 3, pose, intrinsics);
            using (JsonDocument doc = JsonDocument.Parse(json))
            {
                JsonElement root = doc.RootElement;
                Check(root.GetProperty("index").GetInt32() == 7, "index is written as an integer");
                Check(root.GetProperty("epoch").GetInt32() == 3, "epoch is written as an integer");
                Check(Near(root.GetProperty("timestamp").GetDouble(), 12345.5), "timestamp is in milliseconds");
                Check(root.GetProperty("capturedAt").GetInt64() == 1700000000123L, "capturedAt is in epoch milliseconds");

                JsonElement p = root.GetProperty("pose");
                Check(Near(p.GetProperty("position").GetProperty("z").GetDouble(), -2), "position z is written as given");
                Check(Near(p.GetProperty("rotation").GetProperty("y").GetDouble(), 0.5), "rotation y is written");
                Check(Near(p.GetProperty("rotation").GetProperty("w").GetDouble(), 0.8660254), "rotation w is written");

                JsonElement i = root.GetProperty("intrinsics");
                Check(i.GetProperty("width").GetInt32() == 1280 && i.GetProperty("sourceHeight").GetInt32() == 720,
                      "intrinsics carry the frame size");
                Check(Near(i.GetProperty("fovYDeg").GetDouble(), 60), "fovYDeg is written");
            }

            CultureInfo previous = CultureInfo.CurrentCulture;
            CultureInfo.CurrentCulture = new CultureInfo("de-DE");
            try
            {
                string german = KeyframeRecord.ToJson(0, 0.5, 0.5, 0, pose, intrinsics);
                using (JsonDocument doc = JsonDocument.Parse(german))
                {
                    Check(Near(doc.RootElement.GetProperty("timestamp").GetDouble(), 0.5),
                          "numbers stay invariant under a comma-decimal culture");
                }
            }
            finally
            {
                CultureInfo.CurrentCulture = previous;
            }

            string nan = KeyframeRecord.ToJson(0, double.NaN, 1, 0, new PoseF(float.NaN, 0, 0, 0, 0, 0, 1), intrinsics);
            using (JsonDocument doc = JsonDocument.Parse(nan))
            {
                Check(Near(doc.RootElement.GetProperty("timestamp").GetDouble(), 0), "NaN is written as 0, keeping the document valid");
                Check(Near(doc.RootElement.GetProperty("pose").GetProperty("position").GetProperty("x").GetDouble(), 0),
                      "a NaN position component is written as 0");
            }
        }

        // ── Upload retry rule ──────────────────────────────────────────────────────

        private static void UploadPolicyChecks()
        {
            Check(UploadPolicy.IsRetryable(0), "a network error is retried");
            Check(UploadPolicy.IsRetryable(500), "a 500 is retried");
            Check(UploadPolicy.IsRetryable(503), "a 503 is retried");
            Check(UploadPolicy.IsRetryable(408), "a 408 is retried");
            Check(UploadPolicy.IsRetryable(429), "a 429 is retried");
            Check(!UploadPolicy.IsRetryable(400), "a 400 is not retried");
            Check(!UploadPolicy.IsRetryable(401), "a 401 is not retried");
            Check(!UploadPolicy.IsRetryable(404), "a 404 is not retried");
            Check(!UploadPolicy.IsRetryable(413), "a 413 (frame too large) is not retried");
        }

        // ── Frame orientation ──────────────────────────────────────────────────────

        private static void FrameOrientationChecks()
        {
            // A frame 2 pixels wide and 3 tall, reading 0..5 row by row:
            //   0 1
            //   2 3
            //   4 5
            int[] frame = { 0, 1, 2, 3, 4, 5 };

            int w;
            int h;
            int[] upright = FrameOrientation.Upright(frame, 2, 3, 0, false, out w, out h);
            Check(SameInts(upright, frame) && w == 2 && h == 3, "0 degrees with no flip is the identity");

            upright = FrameOrientation.Upright(frame, 2, 3, 90, false, out w, out h);
            Check(SameInts(upright, new[] { 4, 2, 0, 5, 3, 1 }) && w == 3 && h == 2,
                  "90 degrees clockwise turns the columns into rows, bottom pixel first");

            upright = FrameOrientation.Upright(frame, 2, 3, 180, false, out w, out h);
            Check(SameInts(upright, new[] { 5, 4, 3, 2, 1, 0 }) && w == 2 && h == 3, "180 degrees reverses the pixels");

            upright = FrameOrientation.Upright(frame, 2, 3, 270, false, out w, out h);
            Check(SameInts(upright, new[] { 1, 3, 5, 0, 2, 4 }) && w == 3 && h == 2, "270 degrees clockwise, which is 90 anticlockwise");

            upright = FrameOrientation.Upright(frame, 2, 3, 0, true, out w, out h);
            Check(SameInts(upright, new[] { 4, 5, 2, 3, 0, 1 }) && w == 2 && h == 3, "a vertical mirror reverses the rows");

            Check(Throws<ArgumentOutOfRangeException>(() => FrameOrientation.Upright(frame, 2, 3, 45, false, out _, out _)),
                  "a rotation that is not a multiple of 90 is refused");
            Check(Throws<ArgumentException>(() => FrameOrientation.Upright(frame, 2, 2, 0, false, out _, out _)),
                  "a length that does not match width x height is refused");
        }
    }
}
