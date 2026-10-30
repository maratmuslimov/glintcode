pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "glint-kotlin"

include(":glint")

// The Android module needs an SDK, so a plain JVM build leaves it out: -Pglint.android=true adds it.
if (providers.gradleProperty("glint.android").orNull == "true") include(":glint-android")
