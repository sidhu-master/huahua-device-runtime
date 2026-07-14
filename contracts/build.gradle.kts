plugins {
    id("org.jetbrains.kotlin.jvm")
}

group = providers.gradleProperty("GROUP").get()
version = providers.gradleProperty("VERSION_NAME").get()

dependencies {
    testImplementation("junit:junit:4.13.2")
}
