package com.msandh.stickermaker

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Installs the crash reporter as early as possible. */
class StixApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashReporter.install(this)
    }
}

/**
 * Saves a readable report when the app crashes. Nothing is sent anywhere automatically:
 * on the next launch the user can choose to share it (e.g. paste it into a chat).
 */
object CrashReporter {
    private const val FILE = "last-crash.txt"

    fun install(context: Context) {
        val appContext = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                File(appContext.filesDir, FILE).writeText(buildReport(appContext, "Crash on thread ${thread.name}", error))
            } catch (_: Throwable) {
                // Never let reporting hide the original crash.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Returns and deletes the saved report, if any. */
    fun takeReport(context: Context): String? {
        val file = File(context.filesDir, FILE)
        if (!file.exists()) return null
        return try {
            file.readText()
        } finally {
            file.delete()
        }
    }

    fun buildReport(context: Context, title: String, error: Throwable?): String {
        val trace = StringWriter().also { error?.printStackTrace(PrintWriter(it)) }.toString()
        val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.US).format(Date())
        @Suppress("DEPRECATION")
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        } catch (_: Exception) {
            "?"
        }
        return buildString {
            appendLine("Stix report: $title")
            appendLine("Time: $time")
            appendLine("App version: $version")
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine()
            append(trace.take(12_000))
        }
    }
}
