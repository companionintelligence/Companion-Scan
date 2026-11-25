import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.companionintelligence.scan.androidxr.probe"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.companionintelligence.scan.androidxr.probe"
        // The XREAL Aura's Compute Puck runs Android 14 (API 34). XREAL's getting-started page asks for minSdk 35, which
        // would not install there. Every Jetpack XR 1.0.0 artifact declares minSdk 24.
        minSdk = 34
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        // The puck is arm64.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets {
        // The server's poseToMatrix fixture, which meta/'s CoordinateConversionsTest also reads;
        // tests/unit/server/native_quest_pose_fixture.test.ts holds the file to the server's function.
        getByName("test").resources.srcDir("../../meta/app/src/test/resources")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":quest-shared"))

    // ARCore for Jetpack XR's device pose, at the stable 1.0.0. These three are the set another project's Jetpack XR
    // probe created a session with, configured device tracking and tracked on an Aura (2026-11-24), so a first install
    // here does not also test a trimmed set.
    implementation("androidx.xr.runtime:runtime:1.0.0")
    implementation("androidx.xr.scenecore:scenecore:1.0.0")
    implementation("androidx.xr.arcore:arcore:1.0.0")

    // ComponentActivity, lifecycleScope and the permission request.
    implementation("androidx.activity:activity-ktx:1.11.0")

    // probe.json and the recording's keyframes.jsonl lines, at the version meta/ uses.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    testImplementation("junit:junit:4.13.2")
}
