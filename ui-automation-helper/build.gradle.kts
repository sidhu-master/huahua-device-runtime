plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.sidhu.device.uiautomationhelper"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sidhu.device.uiautomationhelper"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.test:runner:1.6.2")
    implementation("com.google.code.gson:gson:2.10.1")
}
