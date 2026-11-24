package com.getcapacitor.myapp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.companionintelligence.scan.MainActivity;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;
import java.util.List;

/**
 * What the installed app declares, read back from the device's package manager: its id, the sign-in return that opens
 * it, the camera permission ScanAR asks for, and ARCore kept optional. Runs on a phone or an emulator only:
 * ./gradlew connectedDebugAndroidTest. The workflow compiles it (assembleDebugAndroidTest) and does not run it.
 *
 * The file keeps the name and folder of Capacitor's template, whose one check asserted the template's own package name.
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void theAppIsCompanionScan() {
        assertEquals("com.companionintelligence.scan", context.getPackageName());
    }

    /** The return from the browser sheet (src/shared/shell-sign-in.ts, SHELL_RETURN_PREFIX) reaches MainActivity and nothing else in the app. */
    @Test
    public void theSignInReturnOpensTheApp() {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("com.companionintelligence.scan://auth?code=x"));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setPackage(context.getPackageName());
        List<ResolveInfo> handlers = context.getPackageManager().queryIntentActivities(intent, 0);
        assertEquals(1, handlers.size());
        assertEquals(MainActivity.class.getName(), handlers.get(0).activityInfo.name);
    }

    @Test
    public void theAppAsksForTheCameraAndKeepsArcoreOptional() throws PackageManager.NameNotFoundException {
        PackageManager packages = context.getPackageManager();
        PackageInfo info = packages.getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
        assertNotNull(info.requestedPermissions);
        assertTrue(Arrays.asList(info.requestedPermissions).contains(Manifest.permission.CAMERA));
        ApplicationInfo app = packages.getApplicationInfo(context.getPackageName(), PackageManager.GET_META_DATA);
        assertEquals("optional", app.metaData.getString("com.google.ar.core"));
    }
}
