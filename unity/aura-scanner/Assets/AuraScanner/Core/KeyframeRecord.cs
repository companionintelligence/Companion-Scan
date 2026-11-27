using System.Globalization;
using System.Text;

namespace AuraScanner.Core
{
    /// The camera intrinsics the server reads from a keyframe's meta record (server/main.ts, normaliseIntrinsics).
    public struct FrameIntrinsics
    {
        public float FovYDeg;
        public float Aspect;
        public int Width;
        public int Height;
        public int SourceWidth;
        public int SourceHeight;
    }

    /// Builds the `meta` field of POST /sessions/:id/keyframes, in the shape the web scanner sends (src/capture/keyframes.ts).
    public static class KeyframeRecord
    {
        public static string ToJson(int index, double timestampMs, double capturedAtMs, int epoch,
                                    PoseF pose, FrameIntrinsics intrinsics)
        {
            var sb = new StringBuilder(384);
            sb.Append('{');
            sb.Append("\"index\":").Append(Int(index));
            sb.Append(",\"timestamp\":").Append(Num(timestampMs));
            sb.Append(",\"capturedAt\":").Append(Num(capturedAtMs));
            sb.Append(",\"epoch\":").Append(Int(epoch));
            sb.Append(",\"pose\":{\"position\":{\"x\":").Append(Num(pose.X))
              .Append(",\"y\":").Append(Num(pose.Y))
              .Append(",\"z\":").Append(Num(pose.Z))
              .Append("},\"rotation\":{\"x\":").Append(Num(pose.Qx))
              .Append(",\"y\":").Append(Num(pose.Qy))
              .Append(",\"z\":").Append(Num(pose.Qz))
              .Append(",\"w\":").Append(Num(pose.Qw))
              .Append("}}");
            sb.Append(",\"intrinsics\":{\"fovYDeg\":").Append(Num(intrinsics.FovYDeg))
              .Append(",\"aspect\":").Append(Num(intrinsics.Aspect))
              .Append(",\"width\":").Append(Int(intrinsics.Width))
              .Append(",\"height\":").Append(Int(intrinsics.Height))
              .Append(",\"sourceWidth\":").Append(Int(intrinsics.SourceWidth))
              .Append(",\"sourceHeight\":").Append(Int(intrinsics.SourceHeight))
              .Append("}}");
            return sb.ToString();
        }

        private static string Int(int value)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }

        /// A finite number in invariant culture, so the decimal separator is always '.'. NaN and infinity have no JSON
        /// form, so they become 0 rather than an invalid document.
        private static string Num(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return "0";
            return value.ToString("R", CultureInfo.InvariantCulture);
        }
    }
}
