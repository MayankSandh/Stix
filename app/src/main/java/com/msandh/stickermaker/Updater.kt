package com.msandh.stickermaker

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates: reads version.json from the public release channel
 * (BuildConfig.UPDATE_INFO_URL), downloads the newer APK, and opens Android's installer.
 * Android only accepts it as an update if it's signed with the same key, so data is kept.
 */
object Updater {
    data class Info(val versionCode: Long, val versionName: String, val apkUrl: String, val notes: String)

    /** Latest published version, or null if nothing is published yet. Network: call off the main thread. */
    fun fetchInfo(): Info? {
        val conn = URL(BuildConfig.UPDATE_INFO_URL).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Cache-Control", "no-cache")
            if (conn.responseCode == 404) return null
            if (conn.responseCode !in 200..299) throw IllegalStateException("Update check failed (error ${conn.responseCode}).")
            val json = JSONObject(conn.inputStream.use { String(it.readBytes(), Charsets.UTF_8) })
            return Info(
                versionCode = json.getLong("versionCode"),
                versionName = json.optString("versionName", json.getLong("versionCode").toString()),
                apkUrl = json.getString("apkUrl"),
                notes = json.optString("notes"),
            )
        } catch (e: FileNotFoundException) {
            return null
        } finally {
            conn.disconnect()
        }
    }

    fun check(): JSONObject {
        val info = fetchInfo()
        val result = JSONObject()
            .put("currentVersion", BuildConfig.VERSION_NAME)
            .put("available", info != null && info.versionCode > BuildConfig.VERSION_CODE)
        if (info != null) result.put("versionName", info.versionName).put("notes", info.notes)
        return result
    }

    /** Downloads the APK and checks it's really a newer Stix before handing it to the installer. */
    fun download(context: Context, info: Info, onProgress: (Int) -> Unit): File {
        require(info.apkUrl.startsWith("https://")) { "Update link isn't secure." }
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "Stix-${info.versionCode}.apk")
        val conn = URL(info.apkUrl).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            if (conn.responseCode !in 200..299) throw IllegalStateException("Download failed (error ${conn.responseCode}).")
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPct = -1
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct != lastPct) { lastPct = pct; onProgress(pct) }
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }

        @Suppress("DEPRECATION")
        val archive = context.packageManager.getPackageArchiveInfo(file.path, 0)
            ?: throw IllegalStateException("The downloaded update is damaged. Try again.")
        check(archive.packageName == context.packageName) { "The downloaded file isn't Stix." }
        check(PackageInfoCompat.getLongVersionCode(archive) > BuildConfig.VERSION_CODE) { "You already have this version." }
        return file
    }

    fun installIntent(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", apk)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
