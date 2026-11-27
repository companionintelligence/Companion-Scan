using AuraScanner.Core;
using UnityEngine;

namespace AuraScanner.Runtime
{
    /// Camera frames through Unity's WebCamTexture, turned upright with the rotation and mirroring the device reports.
    /// Whether the Aura exposes its camera this way is the first device check in the README. If it does not, a Camera2
    /// plugin (the approach of the reference sample's CameraCapturePlugin) takes this class's place behind IFrameSource.
    public sealed class WebCamFrameSource : IFrameSource
    {
        private WebCamTexture _webcam;
        private Texture2D _frame;
        private bool _reported;

        private bool IsRunning => _webcam != null && _webcam.isPlaying;

        /// Starts the first back-facing camera at the requested size. False when the device exposes no camera.
        public bool Start(int requestedWidth, int requestedHeight, int requestedFps)
        {
            WebCamDevice[] devices = WebCamTexture.devices;
            if (devices == null || devices.Length == 0) return false;
            int pick = 0;
            for (int i = 0; i < devices.Length; i++)
            {
                if (!devices[i].isFrontFacing)
                {
                    pick = i;
                    break;
                }
            }
            _webcam = new WebCamTexture(devices[pick].name, requestedWidth, requestedHeight, requestedFps);
            _webcam.Play();
            Debug.Log("[aura-scan] camera " + devices[pick].name + ", requested " + requestedWidth + "x" + requestedHeight);
            return true;
        }

        /// Encodes the newest camera frame as an upright JPEG. False when no new frame has arrived since the last call.
        public bool TryCapture(int jpegQuality, out byte[] jpeg, out int width, out int height)
        {
            jpeg = null;
            width = 0;
            height = 0;
            if (!IsRunning || !_webcam.didUpdateThisFrame) return false;

            int sourceWidth = _webcam.width;
            int sourceHeight = _webcam.height;
            Color32[] pixels = _webcam.GetPixels32();
            if (sourceWidth <= 0 || sourceHeight <= 0 || pixels.Length != sourceWidth * sourceHeight) return false;

            int rotation = _webcam.videoRotationAngle;
            bool mirrored = _webcam.videoVerticallyMirrored;
            if (!_reported)
            {
                _reported = true;
                Debug.Log("[aura-scan] frame " + sourceWidth + "x" + sourceHeight + ", rotation " + rotation + ", mirrored " + mirrored);
            }

            Color32[] upright = FrameOrientation.Upright(pixels, sourceWidth, sourceHeight, rotation, mirrored, out width, out height);
            if (_frame == null || _frame.width != width || _frame.height != height)
            {
                if (_frame != null) UnityEngine.Object.Destroy(_frame);
                _frame = new Texture2D(width, height, TextureFormat.RGBA32, false);
            }
            _frame.SetPixels32(upright);
            _frame.Apply(false);
            jpeg = _frame.EncodeToJPG(jpegQuality);
            return jpeg != null && jpeg.Length > 0;
        }

        public void Dispose()
        {
            if (_webcam != null)
            {
                _webcam.Stop();
                UnityEngine.Object.Destroy(_webcam);
                _webcam = null;
            }
            if (_frame != null)
            {
                UnityEngine.Object.Destroy(_frame);
                _frame = null;
            }
        }
    }
}
