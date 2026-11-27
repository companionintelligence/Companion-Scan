namespace AuraScanner.Core
{
    /// A pose: a position in metres and a unit quaternion. Plain floats, so the core has no engine types.
    public struct PoseF
    {
        public float X;
        public float Y;
        public float Z;
        public float Qx;
        public float Qy;
        public float Qz;
        public float Qw;

        public PoseF(float x, float y, float z, float qx, float qy, float qz, float qw)
        {
            X = x;
            Y = y;
            Z = z;
            Qx = qx;
            Qy = qy;
            Qz = qz;
            Qw = qw;
        }
    }

    /// Converts Unity's pose convention to the one the web scanner and WebXR use.
    ///
    /// Unity is left-handed with +Z forward. Three.js and WebXR are right-handed with -Z forward. Mirroring the Z axis
    /// takes one to the other: a position (x, y, z) becomes (x, y, -z), and a unit quaternion (qx, qy, qz, qw) becomes
    /// (-qx, -qy, qz, qw). The mirror is its own inverse, so applying it twice returns the input.
    public static class PoseConvention
    {
        public static PoseF ToRightHanded(PoseF pose)
        {
            return new PoseF(pose.X, pose.Y, -pose.Z, -pose.Qx, -pose.Qy, pose.Qz, pose.Qw);
        }
    }
}
