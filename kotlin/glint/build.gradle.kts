import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_17 }
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    testImplementation("org.json:json:20250517")
}

tasks.test {
    useJUnitPlatform()
    systemProperty("glint.spec", rootDir.parentFile.resolve("spec").path)
    environment("GLINT_CORPUS", System.getenv("GLINT_CORPUS") ?: "")
    inputs.property("corpus", System.getenv("GLINT_CORPUS") ?: "")
    outputs.upToDateWhen { false }
    maxHeapSize = "1g"
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
