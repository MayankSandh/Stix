package com.msandh.stickermaker

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Log
import androidx.annotation.RequiresApi
import org.json.JSONObject

/**
 * After a sticker is saved, moves the screenshot it came from to the trash (or deletes it),
 * according to the user's setting. With photo access + "Media management" (Android 12+,
 * granted once), Android does it without asking; otherwise it shows its own confirmation.
 * Only images in a Screenshots folder are ever touched.
 */
object ScreenshotCleaner {
    const val KEEP = "keep"
    const val TRASH = "trash"
    const val DELETE = "delete"
    private const val TAG = "ScreenshotCleaner"
    private const val PREFS = "screenshots"
    private const val KEY_MODE = "mode"
    private const val KEY_SETUP_OFFERED = "setupOffered"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun mode(context: Context): String = prefs(context).getString(KEY_MODE, TRASH) ?: TRASH

    fun setMode(context: Context, mode: String) {
        require(mode in listOf(KEEP, TRASH, DELETE)) { "Unknown option" }
        prefs(context).edit().putString(KEY_MODE, mode).apply()
    }

    fun setupOffered(context: Context) = prefs(context).getBoolean(KEY_SETUP_OFFERED, false)

    fun markSetupOffered(context: Context) = prefs(context).edit().putBoolean(KEY_SETUP_OFFERED, true).apply()

    /** Android 11+ is needed for trash; 12+ for prompt-free cleanup. */
    fun supported() = Build.VERSION.SDK_INT >= 30

    fun readPermission() =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasRead(context: Context) =
        context.checkSelfPermission(readPermission()) == PackageManager.PERMISSION_GRANTED

    fun hasManageMedia(context: Context) = Build.VERSION.SDK_INT >= 31 && MediaStore.canManageMedia(context)

    /** True when cleanup happens silently, with no prompt. */
    fun hasSilentAccess(context: Context) = hasRead(context) && hasManageMedia(context)

    fun status(context: Context): JSONObject = JSONObject()
        .put("mode", mode(context))
        .put("supported", supported())
        .put("silent", hasSilentAccess(context))
        .put("canBeSilent", Build.VERSION.SDK_INT >= 31)
        .put("photoAccess", hasRead(context))
        .put("mediaManagement", hasManageMedia(context))

    /**
     * Finds the gallery item behind a shared image, if it's a screenshot.
     * The screenshot preview's Share button hands over the gallery item directly; other apps
     * (e.g. Google Photos) hand over a copy, which is matched by name and size (needs photo access).
     */
    @RequiresApi(30)
    fun findScreenshot(context: Context, shared: Uri): Uri? {
        val resolver = context.contentResolver
        if (shared.authority == MediaStore.AUTHORITY) {
            return if (isScreenshot(context, shared)) shared else null
        }
        if (!hasRead(context)) return null
        val (name, size) = try {
            resolver.query(shared, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (!c.moveToFirst()) return null
                c.getString(0) to c.getLong(1)
            } ?: return null
        } catch (e: Exception) {
            Log.w(TAG, "Can't read shared item details", e)
            return null
        }
        if (name.isNullOrBlank()) return null
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        resolver.query(
            collection,
            arrayOf(MediaStore.Images.Media._ID),
            "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.SIZE} = ?",
            arrayOf(name, size.toString()),
            "${MediaStore.Images.Media.DATE_ADDED} DESC",
        )?.use { c ->
            if (c.moveToFirst()) {
                val uri = ContentUris.withAppendedId(collection, c.getLong(0))
                if (isScreenshot(context, uri)) return uri
            }
        }
        return null
    }

    @RequiresApi(30)
    private fun isScreenshot(context: Context, uri: Uri): Boolean = try {
        context.contentResolver.query(
            uri,
            arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.Images.Media.BUCKET_DISPLAY_NAME, MediaStore.MediaColumns.DISPLAY_NAME),
            null, null, null,
        )?.use { c ->
            if (!c.moveToFirst()) return false
            (0 until c.columnCount).any { c.getString(it)?.contains("screenshot", ignoreCase = true) == true }
        } ?: false
    } catch (e: Exception) {
        Log.w(TAG, "Can't check whether $uri is a screenshot", e)
        false
    }

    /** Android's request to trash/delete; it completes without UI when [hasSilentAccess]. */
    @RequiresApi(30)
    fun request(context: Context, uri: Uri, mode: String): IntentSender {
        val uris = listOf(uri)
        return if (mode == DELETE) {
            MediaStore.createDeleteRequest(context.contentResolver, uris).intentSender
        } else {
            MediaStore.createTrashRequest(context.contentResolver, uris, true).intentSender
        }
    }
}
