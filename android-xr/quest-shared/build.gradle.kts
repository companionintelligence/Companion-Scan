import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
}

/*
 * The Quest app's pure-Kotlin pose, clock, frame and keyframe-shape code, compiled here from where it lives in meta/, so
 * there is one copy of it (wave 17 ticket 0003: "Share that code, or port it with its tests").
 *
 * Each file is named. Everything else in meta/ (the Meta Spatial SDK, Camera2 glue, the uploader's HTTP client, ONNX
 * Runtime) stays out, and a file that moves or is renamed in meta/ fails this build at once instead of going missing.
 * The packages keep their Quest names, so the Quest app's imports do not change.
 *
 * Their tests stay in meta/app/src/test and run there (`./gradlew :app:testDebugUnitTest` in meta/); the probe's own tests
 * cover what the probe builds on top of them.
 */
val questSources: Directory = layout.projectDirectory.dir("../../meta/app/src/main/java")
val sharedQuestFiles = listOf(
    "pose/Clocks.kt",
    "pose/CoordinateConversions.kt",
    "pose/EpochTracker.kt",
    "pose/PoseMath.kt",
    "pose/PoseRingBuffer.kt",
    "capture/KeyframeSelector.kt",
    "capture/YuvFrame.kt",
    "upload/KeyframeMeta.kt",
).map { "com/companionintelligence/scan/quest/$it" }

for (path in sharedQuestFiles) {
    check(questSources.file(path).asFile.isFile) { "meta/app/src/main/java/$path is missing: the shared Quest file moved" }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
    sourceSets.named("main") {
        kotlin.setSrcDirs(listOf(questSources))
        kotlin.include(sharedQuestFiles)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

dependencies {
    // KeyframeMeta builds its JSON with it, at the version meta/app/build.gradle.kts declares.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
}
