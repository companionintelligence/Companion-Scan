package com.getcapacitor.myapp;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.companionintelligence.scan.ScanARRules;
import com.companionintelligence.scan.ScanARRules.InstallStep;
import com.companionintelligence.scan.ScanARRules.StartPlan;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.TrackingState;

import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * The ScanAR plugin's rules that need no phone (ScanARRules): the tracking words, ARCore's install step, what a start()
 * does to a running session, and the upright turn of a camera frame. Runs on the JVM: ./gradlew testDebugUnitTest.
 *
 * The file keeps the name and folder of Capacitor's template, which held one 2 + 2 = 4 check here.
 */
public class ExampleUnitTest {

    /** Every tracking word either plugin may send: src/ar/native-codec.ts reads exactly these. */
    private static final Set<String> WORDS = new HashSet<>(Arrays.asList(
        "normal", "notAvailable", "limited", "limited.initializing", "limited.excessiveMotion",
        "limited.insufficientFeatures", "limited.relocalizing"));

    @Test
    public void everyStateAndReasonIsSentAsAWordTheWebSideReads_andNeverAsRelocalizing() {
        for (TrackingState state : TrackingState.values()) {
            for (TrackingFailureReason reason : TrackingFailureReason.values()) {
                for (boolean tracked : new boolean[] { false, true }) {
                    String word = ScanARRules.trackingName(state, reason, tracked);
                    assertTrue(state + "/" + reason + " is sent as " + word, WORDS.contains(word));
                    // ARCore has no relocalization state, and none is made up for it.
                    assertNotEquals("limited.relocalizing", word);
                }
            }
        }
    }

    @Test
    public void trackingAndStoppedAreNormalAndNotAvailable() {
        assertEquals("normal", ScanARRules.trackingName(TrackingState.TRACKING, TrackingFailureReason.NONE, false));
        assertEquals("notAvailable", ScanARRules.trackingName(TrackingState.STOPPED, TrackingFailureReason.NONE, true));
    }

    @Test
    public void aPauseWithNoReasonIsInitializingOnlyUntilTheSessionHasTracked() {
        assertEquals("limited.initializing", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.NONE, false));
        assertEquals("limited", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.NONE, true));
    }

    @Test
    public void theReasonsAreArkitsWords() {
        assertEquals("limited.excessiveMotion", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.EXCESSIVE_MOTION, true));
        assertEquals("limited.insufficientFeatures", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.INSUFFICIENT_FEATURES, true));
        // ARKit folds a scene too dark to track into insufficient features.
        assertEquals("limited.insufficientFeatures", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.INSUFFICIENT_LIGHT, false));
        // Another app has the camera: what iOS reports for an ARKit interruption.
        assertEquals("notAvailable", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.CAMERA_UNAVAILABLE, true));
        assertEquals("limited", ScanARRules.trackingName(TrackingState.PAUSED, TrackingFailureReason.BAD_STATE, false));
    }

    @Test
    public void arcoreThatCanRunButIsMissingOrOldIsInstalledThroughGooglePlay() {
        assertSame(InstallStep.READY, ScanARRules.installStep(ArCoreApk.Availability.SUPPORTED_INSTALLED));
        assertSame(InstallStep.REQUEST_INSTALL, ScanARRules.installStep(ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED));
        assertSame(InstallStep.REQUEST_INSTALL, ScanARRules.installStep(ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD));
        assertSame(InstallStep.UNSUPPORTED, ScanARRules.installStep(ArCoreApk.Availability.UNSUPPORTED_DEVICE_NOT_CAPABLE));
        assertSame(InstallStep.CHECKING, ScanARRules.installStep(ArCoreApk.Availability.UNKNOWN_CHECKING));
        assertSame(InstallStep.CHECKING, ScanARRules.installStep(ArCoreApk.Availability.UNKNOWN_TIMED_OUT));
        assertSame(InstallStep.CHECKING, ScanARRules.installStep(ArCoreApk.Availability.UNKNOWN_ERROR));
        for (ArCoreApk.Availability availability : ArCoreApk.Availability.values()) {
            // Every state has a step: a state a later ARCore adds is still being worked out, never a session.
            InstallStep step = ScanARRules.installStep(availability);
            assertTrue(availability + " opens a session only when installed",
                step != InstallStep.READY || availability == ArCoreApk.Availability.SUPPORTED_INSTALLED);
        }
    }

    @Test
    public void startAnswersWithTheRunningSessionOnlyForTheSameDepth() {
        assertSame(StartPlan.START, ScanARRules.startPlan(false, false, 20, true, 20));
        assertSame(StartPlan.REUSE, ScanARRules.startPlan(true, false, 20, false, 20));
        assertSame(StartPlan.REUSE, ScanARRules.startPlan(true, true, 20, true, 20));
        assertSame(StartPlan.REUSE_WITH_NEW_GRID, ScanARRules.startPlan(true, false, 20, false, 10));
        assertSame(StartPlan.RESTART, ScanARRules.startPlan(true, false, 20, true, 20));
        assertSame(StartPlan.RESTART, ScanARRules.startPlan(true, true, 20, false, 10));
        // A grid outside 2 to 40 is the grid at the nearest end, so asking for 100 again is no change.
        assertSame(StartPlan.REUSE, ScanARRules.startPlan(true, false, 40, false, 100));
    }

    @Test
    public void theHitGridIsKeptToTwoToForty() {
        assertEquals(2, ScanARRules.clampHitGrid(-5));
        assertEquals(2, ScanARRules.clampHitGrid(2));
        assertEquals(20, ScanARRules.clampHitGrid(ScanARRules.DEFAULT_HIT_GRID));
        assertEquals(40, ScanARRules.clampHitGrid(41));
    }

    /**
     * A 4 × 2 NV21 frame: luma 0..7 row by row, then one row of chroma pairs (V0, U0, V1, U1) = (100, 101, 110, 111).
     *
     *   luma      0 1 2 3        chroma   (V0 U0) (V1 U1)
     *             4 5 6 7
     */
    private static byte[] frame() {
        return new byte[] { 0, 1, 2, 3, 4, 5, 6, 7, 100, 101, 110, 111 };
    }

    @Test
    public void aQuarterTurnClockwisePutsTheLeftColumnOnTop() {
        byte[] out = ScanARRules.rotateNv21(frame(), 4, 2, 90);
        // 2 × 4 now: the bottom-left sample (4) is the top-left one, as a turn of the phone puts it.
        assertArrayEquals(new byte[] {
            4, 0,
            5, 1,
            6, 2,
            7, 3,
            // The 2 × 1 chroma grid becomes 1 × 2: one pair per row, each pair kept as V, U.
            100, 101,
            110, 111,
        }, out);
        assertTrue(ScanARRules.isQuarterTurn(90));
        assertTrue(ScanARRules.isQuarterTurn(270));
        assertFalse(ScanARRules.isQuarterTurn(180));
        assertFalse(ScanARRules.isQuarterTurn(0));
    }

    @Test
    public void aHalfTurnAndAThreeQuarterTurn() {
        assertArrayEquals(new byte[] { 7, 6, 5, 4, 3, 2, 1, 0, 110, 111, 100, 101 }, ScanARRules.rotateNv21(frame(), 4, 2, 180));
        assertArrayEquals(new byte[] { 3, 7, 2, 6, 1, 5, 0, 4, 110, 111, 100, 101 }, ScanARRules.rotateNv21(frame(), 4, 2, 270));
    }

    @Test
    public void noTurnIsTheFrameItselfAndFourTurnsComeBackToIt() {
        byte[] original = frame();
        assertSame(original, ScanARRules.rotateNv21(original, 4, 2, 0));
        assertSame(original, ScanARRules.rotateNv21(original, 4, 2, 360));
        byte[] turned = original;
        int width = 4;
        int height = 2;
        for (int i = 0; i < 4; i++) {
            turned = ScanARRules.rotateNv21(turned, width, height, 90);
            int swap = width;
            width = height;
            height = swap;
        }
        assertArrayEquals(original, turned);
        // A negative angle is the same turn the other way: -90 is 270.
        assertArrayEquals(ScanARRules.rotateNv21(original, 4, 2, 270), ScanARRules.rotateNv21(original, 4, 2, -90));
    }

    @Test
    public void aFrameNv21CannotHoldIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> ScanARRules.rotateNv21(new byte[12], 3, 2, 90));
        assertThrows(IllegalArgumentException.class, () -> ScanARRules.rotateNv21(new byte[11], 4, 2, 90));
        assertThrows(IllegalArgumentException.class, () -> ScanARRules.rotateNv21(new byte[0], 0, 0, 90));
    }
}
