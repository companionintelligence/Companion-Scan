import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.companionintelligence.scan.quest"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.companionintelligence.scan.quest"
        minSdk = 34
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        // Quest 3 and 3S run arm64 only. Without this filter ONNX Runtime would add its armeabi-v7a, x86 and
        // x86_64 libraries to the APK as well. Filtering needs no NDK.
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// The libraries in the release APK are locked in app/gradle.lockfile, and the app's third-party
// notices list them from it (scripts/native/third-party-notices.mjs --shell quest). The release
// build uses the versions locked there, and fails when it would take in a library the lockfile
// does not list or leave out one it does, so the notices cannot fall behind the APK. After
// changing a dependency, run here in meta/:
//   ./gradlew :app:dependencies --configuration releaseRuntimeClasspath --write-locks
configurations.matching { it.name == "releaseRuntimeClasspath" }.configureEach {
    resolutionStrategy.activateDependencyLocking()
}

dependencies {
    implementation("com.meta.spatial:meta-spatial-sdk:0.15.0")
    implementation("com.meta.spatial:meta-spatial-sdk-toolkit:0.15.0")
    implementation("com.meta.spatial:meta-spatial-sdk-vr:0.15.0")
    implementation("com.meta.spatial:meta-spatial-sdk-splat:0.15.0")

    // Both are already compile dependencies of meta-spatial-sdk 0.15.0 (its POM), declared here at the same
    // versions because this code calls them directly. Declaring them does not change the resolved versions.
    implementation("com.squareup.okhttp3:okhttp:4.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // On-device vision hook (vision/OnnxVisionModel.kt). No model weights are bundled.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.32.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.9.1")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.9.1")
}
