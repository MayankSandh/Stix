plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val appId = "com.msandh.stickermaker"
// Must start with the package name. WhatsApp reads stickers through this content provider.
val providerAuthority = "$appId.stickercontentprovider"
// CI passes these in; without them the release build falls back to the debug key.
val keystorePath: String? = System.getenv("SIGNING_KEYSTORE_PATH")
// Public repo the app checks for updates (only release files live there, not the code).
val updateRepo = System.getenv("UPDATE_REPO") ?: "MayankSandh/Stix-releases"

android {
    namespace = appId
    compileSdk = 35

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 35
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "1.0.$versionCode"
        manifestPlaceholders["contentProviderAuthority"] = providerAuthority
        buildConfigField("String", "CONTENT_PROVIDER_AUTHORITY", "\"$providerAuthority\"")
        buildConfigField("String", "UPDATE_INFO_URL", "\"https://github.com/$updateRepo/releases/latest/download/version.json\"")
    }

    signingConfigs {
        keystorePath?.let { path ->
            create("release") {
                storeFile = file(path)
                storePassword = System.getenv("SIGNING_STORE_PASSWORD")
                keyAlias = System.getenv("SIGNING_KEY_ALIAS")
                keyPassword = System.getenv("SIGNING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    // On-device "magic cut-out" (model is downloaded by Google Play services).
    implementation("com.google.android.gms:play-services-mlkit-subject-segmentation:16.0.0-beta1")
    implementation("com.google.android.gms:play-services-base:18.5.0")
}
