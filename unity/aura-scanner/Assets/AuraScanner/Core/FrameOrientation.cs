using System;

namespace AuraScanner.Core
{
    /// Makes a frame upright. WebCamTexture reports the clockwise rotation a frame needs (videoRotationAngle) and whether
    /// it is mirrored vertically (videoVerticallyMirrored). Pure, so the harness checks it on plain arrays.
    public static class FrameOrientation
    {
        /// Returns the upright pixels, row by row, and their new size. The rotation is clockwise, in degrees, and must be a
        /// multiple of 90. The vertical flip is applied to the rotated frame.
        public static T[] Upright<T>(T[] source, int width, int height, int rotationDegrees, bool flipVertical,
                                     out int uprightWidth, out int uprightHeight)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            if (width <= 0 || height <= 0 || source.Length != width * height)
            {
                throw new ArgumentException("the source length must equal width x height");
            }
            int angle = ((rotationDegrees % 360) + 360) % 360;
            if (angle % 90 != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(rotationDegrees), "must be a multiple of 90");
            }

            bool quarterTurn = angle == 90 || angle == 270;
            uprightWidth = quarterTurn ? height : width;
            uprightHeight = quarterTurn ? width : height;
            var result = new T[uprightWidth * uprightHeight];
            for (int y = 0; y < uprightHeight; y++)
            {
                int row = flipVertical ? uprightHeight - 1 - y : y;
                for (int x = 0; x < uprightWidth; x++)
                {
                    int sourceX;
                    int sourceY;
                    switch (angle)
                    {
                        case 90:
                            sourceX = row;
                            sourceY = height - 1 - x;
                            break;
                        case 180:
                            sourceX = width - 1 - x;
                            sourceY = height - 1 - row;
                            break;
                        case 270:
                            sourceX = width - 1 - row;
                            sourceY = x;
                            break;
                        default:
                            sourceX = x;
                            sourceY = row;
                            break;
                    }
                    result[y * uprightWidth + x] = source[sourceY * width + sourceX];
                }
            }
            return result;
        }
    }
}
