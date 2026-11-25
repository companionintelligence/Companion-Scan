pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "CompanionScanAndroidXr"

// The Quest app's pure-Kotlin pose, clock, frame and keyframe code, compiled from meta/ (quest-shared/build.gradle.kts).
include(":quest-shared")

// Wave 17 ticket 0003's spike: camera 0 and the head pose on one clock, on an XREAL Aura.
include(":probe")
