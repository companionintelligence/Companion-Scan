using System;

namespace AuraScanner.Runtime
{
    /// Where a keyframe's JPEG comes from: a camera, or generated frames for testing the upload path.
    public interface IFrameSource : IDisposable
    {
        /// Starts the source at the requested size. False when it cannot start, for example when no camera is present.
        bool Start(int requestedWidth, int requestedHeight, int requestedFps);

        /// Encodes the newest frame as an upright JPEG. False when there is no new frame to send.
        bool TryCapture(int jpegQuality, out byte[] jpeg, out int width, out int height);
    }
}
