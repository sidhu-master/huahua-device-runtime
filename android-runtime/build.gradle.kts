plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

group = providers.gradleProperty("GROUP").get()
version = providers.gradleProperty("VERSION_NAME").get()

android {
    namespace = "com.sidhu.device.runtime.android"
    compileSdk = 36

    defaultConfig {
        minSdk = 30
    }
}

dependencies {
    api(project(":contracts"))
    testImplementation("junit:junit:4.13.2")
}
