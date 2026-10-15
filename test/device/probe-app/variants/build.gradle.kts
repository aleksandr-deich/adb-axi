plugins {
    alias(libs.plugins.android.application)
}

// Code-free builds of dev.probe whose only purpose is a real package-manager answer:
// a newer version, another signer, a minSdk above the CI API levels, testOnly, a
// required library no device has, and native code for an ABI no CI emulator runs.
android {
    namespace = "dev.probe.variants"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.probe"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        // Test-only key, committed on purpose: it exists to sign a build that differs from
        // the debug key. Never use it for anything that ships.
        create("otherSigner") {
            storeFile = file("test-only-other-signer.jks")
            storePassword = "android"
            keyAlias = "other"
            keyPassword = "android"
        }
    }

    flavorDimensions += "variant"
    productFlavors {
        create("v2") {
            versionCode = 2
            versionName = "2.0"
        }
        create("othersigner") {
            signingConfig = signingConfigs.getByName("otherSigner")
        }
        create("minsdk36") {
            minSdk = 36
        }
        create("flaggedtest")
        create("needslib")
        create("riscvonly")
    }

    buildTypes {
        debug {
            signingConfig = null
            // The Kotlin standard library is added by default; nothing uses it.
            isMinifyEnabled = true
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }
}

androidComponents {
    onVariants { variant ->
        if (variant.flavorName != "othersigner") {
            variant.signingConfig.setConfig(android.signingConfigs.getByName("debug"))
        }
    }
}
