package com.companionintelligence.scan;

import com.google.ar.core.ArCoreApk;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.TrackingState;

/**
 * The ScanAR plugin's rules on Android that need no device: the tracking word a frame is sent with, what start()
 * does about ARCore's availability, and what a start() call does to a session that is already running. Nothing here
 * touches the Android framework or an ARCore session, so the JVM unit tests (app/src/test) run every branch.
 *
 * The iOS plugin (mobile/ios/App/App/ScanARPlugin.swift) keeps the same contract: its describe() sends the same
 * tracking words, and its start() answers the same options the same way.
 */
public final class ScanARRules {
    /** The hit-test grid's side, in samples, when start() names none. Both plugins use 20. */
    public static final int DEFAULT_HIT_GRID = 20;

    private ScanARRules() {
    }

    /**
     * The tracking word for a frame, in the words both plugins send (src/ar/native-codec.ts reads them):
     * normal, notAvailable, limited, limited.initializing, limited.excessiveMotion and limited.insufficientFeatures.
     *
     * - ARCore's INSUFFICIENT_LIGHT is sent as limited.insufficientFeatures, the reason ARKit gives for a scene too
     *   dark or too plain to track.
     * - CAMERA_UNAVAILABLE (another app has the camera) is sent as notAvailable, as the iOS plugin reports an ARKit
     *   interruption.
     * - A pause with no reason is the start of a session, so it reads as initializing until the session has tracked
     *   once ({@code everTracked}). After that it is a loss without a stated cause, sent as plain limited: the session
     *   is not starting over.
     * - BAD_STATE, and a reason this build does not know, are plain limited, as iOS sends a reason it does not know.
     *
     * ARCore has no relocalization state, so limited.relocalizing, which ARKit alone sends, is never sent here.
     */
    public static String trackingName(TrackingState state, TrackingFailureReason reason, boolean everTracked) {
        switch (state) {
            case TRACKING:
                return "normal";
            case STOPPED:
                return "notAvailable";
            case PAUSED:
                if (reason == TrackingFailureReason.EXCESSIVE_MOTION) {
                    return "limited.excessiveMotion";
                }
                if (reason == TrackingFailureReason.INSUFFICIENT_FEATURES || reason == TrackingFailureReason.INSUFFICIENT_LIGHT) {
                    return "limited.insufficientFeatures";
                }
                if (reason == TrackingFailureReason.CAMERA_UNAVAILABLE) {
                    return "notAvailable";
                }
                if (reason == TrackingFailureReason.NONE && !everTracked) {
                    return "limited.initializing";
                }
                return "limited";
            default:
                return "limited";
        }
    }

    /** What start() does about ARCore before it opens a session. */
    public enum InstallStep {
        /** ARCore is installed: open the session. */
        READY,
        /** ARCore can run here but is missing or too old: ask Google Play to install or update it, then open the session. */
        REQUEST_INSTALL,
        /** ARCore is still finding out what this device can do: the answer is not final, so the caller asks again. */
        CHECKING,
        /** This device cannot run ARCore. */
        UNSUPPORTED,
    }

    /** The step for an ARCore availability. Every state that is not named is one ARCore is still working out. */
    public static InstallStep installStep(ArCoreApk.Availability availability) {
        switch (availability) {
            case SUPPORTED_INSTALLED:
                return InstallStep.READY;
            case SUPPORTED_NOT_INSTALLED:
            case SUPPORTED_APK_TOO_OLD:
                return InstallStep.REQUEST_INSTALL;
            case UNSUPPORTED_DEVICE_NOT_CAPABLE:
                return InstallStep.UNSUPPORTED;
            default:
                return InstallStep.CHECKING;
        }
    }

    /** What a start() call does to the session that is running, if one is. */
    public enum StartPlan {
        /** No session runs: start one with the options given. */
        START,
        /** One runs with these options: answer with it. */
        REUSE,
        /** One runs with the same depth and another hit grid: the hit samples follow the new grid, and the reply is the running session. */
        REUSE_WITH_NEW_GRID,
        /** One runs with the other depth setting, which is a different ARCore configuration: stop it, and start one with these options. */
        RESTART,
    }

    /**
     * The plan for start({ depth, hitGrid }) when a session {@code running} was started with {@code runningDepth} and
     * samples a {@code runningHitGrid} grid. The reply always describes the session the caller asked for, as on iOS.
     */
    public static StartPlan startPlan(boolean running, boolean runningDepth, int runningHitGrid, boolean wantDepth, int wantHitGrid) {
        if (!running) {
            return StartPlan.START;
        }
        if (runningDepth != wantDepth) {
            return StartPlan.RESTART;
        }
        return clampHitGrid(runningHitGrid) == clampHitGrid(wantHitGrid) ? StartPlan.REUSE : StartPlan.REUSE_WITH_NEW_GRID;
    }

    /** The hit grid's side, kept to 2 to 40 samples, the range both plugins keep it to. */
    public static int clampHitGrid(int requested) {
        return Math.max(2, Math.min(requested, 40));
    }

    /** True when turning by {@code degrees} (a multiple of 90) swaps the image's width and height. */
    public static boolean isQuarterTurn(int degrees) {
        return quarterTurns(degrees) % 2 == 1;
    }

    private static int quarterTurns(int degrees) {
        return ((degrees % 360) + 360) % 360 / 90;
    }

    /**
     * An NV21 image ({@code width} × {@code height}: the Y plane, then interleaved V and U at half resolution) turned
     * clockwise by {@code degrees}, a multiple of 90, as NV21 again. A quarter turn gives a {@code height} × {@code width}
     * image. The camera's sensor orientation is the turn that makes its image upright in the phone's natural orientation,
     * so the frame is turned here, in the YUV data, and compressed to JPEG once. Width and height must be even, as NV21's
     * are. The turn matches ScanARRenderer.rotateFloats(), which turns the depth map the same way.
     */
    public static byte[] rotateNv21(byte[] nv21, int width, int height, int degrees) {
        if (width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0) {
            throw new IllegalArgumentException("NV21 needs a positive, even width and height, not " + width + "×" + height);
        }
        int lumaBytes = width * height;
        if (nv21.length < lumaBytes + lumaBytes / 2) {
            throw new IllegalArgumentException("an NV21 image of " + width + "×" + height + " needs " + (lumaBytes + lumaBytes / 2) + " bytes, not " + nv21.length);
        }
        int turns = quarterTurns(degrees);
        if (turns == 0) {
            return nv21;
        }
        byte[] out = new byte[lumaBytes + lumaBytes / 2];
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                out[lumaIndex(x, y, width, height, turns)] = nv21[y * width + x];
            }
        }
        // The chroma plane is a (width / 2) × (height / 2) grid of V, U pairs, turned as one grid of pairs.
        int chromaWidth = width / 2;
        int chromaHeight = height / 2;
        for (int y = 0; y < chromaHeight; y++) {
            for (int x = 0; x < chromaWidth; x++) {
                int from = lumaBytes + y * width + x * 2;
                int to = lumaBytes + 2 * lumaIndex(x, y, chromaWidth, chromaHeight, turns);
                out[to] = nv21[from];
                out[to + 1] = nv21[from + 1];
            }
        }
        return out;
    }

    /** Where the sample at (x, y) of a w × h grid lands, row-major, once the grid is turned clockwise `turns` quarter turns. */
    private static int lumaIndex(int x, int y, int w, int h, int turns) {
        switch (turns) {
            case 1: // 90 clockwise: (x, y) -> (h - 1 - y, x), output width h
                return x * h + (h - 1 - y);
            case 2: // 180: (x, y) -> (w - 1 - x, h - 1 - y), output width w
                return (h - 1 - y) * w + (w - 1 - x);
            default: // 270 clockwise: (x, y) -> (y, w - 1 - x), output width h
                return (w - 1 - x) * h + y;
        }
    }
}
