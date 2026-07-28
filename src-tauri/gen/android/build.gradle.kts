buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

// Pin Build Tools to what the Dockerfile installs.
//
// AGP 8.11 otherwise asks for its own default, 35.0.0, while the image carries
// only 36.0.0 (matching compileSdk). Gradle then reaches for dl.google.com in
// the middle of the build, so an offline build fails outright and an online one
// silently depends on a download nothing declares.
//
// Set here rather than in each module because `:tauri-android` is generated and
// not under version control, so it cannot carry the pin itself.
subprojects {
    val pinBuildTools = {
        extensions.configure<com.android.build.gradle.BaseExtension>("android") {
            buildToolsVersion = "36.0.0"
        }
    }
    pluginManager.withPlugin("com.android.application") { pinBuildTools() }
    pluginManager.withPlugin("com.android.library") { pinBuildTools() }
}

tasks.register("clean").configure {
    delete("build")
}

