using System;
using UnityEngine;

namespace AuraScanner.Runtime
{
    /// Generated JPEGs, for testing the upload path without a camera. The frames show no room, so a scan made with them
    /// cannot be reconstructed: use this only to check connectivity, sign-in and the keyframe contract.
    public sealed class PlaceholderFrame : IFrameSource
    {
        private int _width = 640;
        private int _height = 480;
        private int _index;

        public bool Start(int requestedWidth, int requestedHeight, int requestedFps)
        {
            _width = Math.Max(16, requestedWidth);
            _height = Math.Max(16, requestedHeight);
            return true;
        }

        public bool TryCapture(int jpegQuality, out byte[] jpeg, out int width, out int height)
        {
            width = _width;
            height = _height;
            jpeg = Encode(_width, _height, _index++, jpegQuality);
            return jpeg != null && jpeg.Length > 0;
        }

        public void Dispose()
        {
        }

        private static byte[] Encode(int width, int height, int index, int quality)
        {
            var colours = new Color32[width * height];
            byte blue = (byte)(index * 37 % 256);
            for (int i = 0; i < colours.Length; i++)
            {
                int x = i % width;
                int y = i / width;
                colours[i] = new Color32((byte)(x * 255 / (width - 1)), (byte)(y * 255 / (height - 1)), blue, 255);
            }
            var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
            texture.SetPixels32(colours);
            texture.Apply(false);
            byte[] jpeg = texture.EncodeToJPG(quality);
            UnityEngine.Object.Destroy(texture);
            return jpeg;
        }
    }
}
