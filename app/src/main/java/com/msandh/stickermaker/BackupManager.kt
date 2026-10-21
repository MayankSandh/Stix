package com.msandh.stickermaker

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Keeps one backup file (chosen by the user through Android's file picker, e.g. in Google Drive)
 * up to date: a few seconds after any change, the whole collection is written to it again.
 */
class BackupManager private constructor(private val context: Context, private val repo: StickerRepository) {
    private val prefs = context.getSharedPreferences("backup", Context.MODE_PRIVATE)
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val scheduleLock = Any()
    private var pending: ScheduledFuture<*>? = null

    init {
        repo.onChanged = { onDataChanged() }
        // Catch up if the app closed before the last change was backed up.
        if (prefs.getBoolean(KEY_DIRTY, false) && location() != null) schedule(2)
    }

    fun location(): Uri? = prefs.getString(KEY_URI, null)?.let(Uri::parse)

    /** Remembers [uri] as the backup file, keeping permission to write it across restarts. */
    fun setLocation(uri: Uri) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        context.contentResolver.takePersistableUriPermission(uri, flags)
        val old = location()
        if (old != null && old != uri) {
            runCatching { context.contentResolver.releasePersistableUriPermission(old, flags) }
        }
        prefs.edit()
            .putString(KEY_URI, uri.toString())
            .putString(KEY_NAME, describe(uri))
            .remove(KEY_ERROR)
            .apply()
    }

    /** Writes the backup now. Throws with a readable message on failure. */
    @Synchronized
    fun backupNow(): JSONObject {
        val uri = location() ?: throw IllegalStateException("Choose where to keep the backup first.")
        try {
            openForWrite(uri).use { repo.writeBackup(it) }
            prefs.edit()
                .putLong(KEY_LAST, System.currentTimeMillis())
                .putBoolean(KEY_DIRTY, false)
                .remove(KEY_ERROR)
                .apply()
        } catch (e: Exception) {
            Log.e(TAG, "Backup failed", e)
            val message = if (e is SecurityException) {
                "Stix lost access to the backup file. Choose it again."
            } else {
                e.message ?: e.javaClass.simpleName
            }
            prefs.edit().putString(KEY_ERROR, message).apply()
            throw IllegalStateException("Backup failed: $message", e)
        }
        return status()
    }

    fun status(): JSONObject = JSONObject()
        .put("location", prefs.getString(KEY_NAME, null) ?: JSONObject.NULL)
        .put("lastBackupAt", prefs.getLong(KEY_LAST, 0L))
        .put("error", prefs.getString(KEY_ERROR, null) ?: JSONObject.NULL)
        .put("pending", prefs.getBoolean(KEY_DIRTY, false))

    /** Copies a picked backup into the app's cache and reports what's inside, without restoring. */
    fun inspect(uri: Uri): JSONObject {
        val copy = restoreCopy()
        context.contentResolver.openInputStream(uri)?.use { input -> copy.outputStream().use { input.copyTo(it) } }
            ?: throw IllegalStateException("Couldn't open that file.")
        val summary = repo.readBackupSummary(copy)
        return JSONObject()
            .put("createdAt", summary.createdAt)
            .put("packs", summary.packs)
            .put("stickers", summary.stickers)
            .put("name", describe(uri))
    }

    /** Restores the backup previously passed to [inspect]. Optionally keeps backing up to that same file. */
    fun restore(sourceUri: Uri?): JSONObject {
        val copy = restoreCopy()
        require(copy.isFile) { "Pick the backup file again." }
        repo.restoreBackup(copy)
        copy.delete()
        if (location() == null && sourceUri != null) {
            // On a new phone, carry on backing up to the file we just restored from.
            runCatching { setLocation(sourceUri) }.onFailure { Log.w(TAG, "Can't reuse restored file for backups", it) }
        }
        return status()
    }

    private fun restoreCopy() = File(File(context.cacheDir, "restore").apply { mkdirs() }, "backup.zip")

    private fun onDataChanged() {
        prefs.edit().putBoolean(KEY_DIRTY, true).apply()
        if (location() != null) schedule(5)
    }

    private fun schedule(delaySeconds: Long) {
        synchronized(scheduleLock) {
            pending?.cancel(false)
            pending = scheduler.schedule({ runCatching { backupNow() } }, delaySeconds, TimeUnit.SECONDS)
        }
    }

    private fun openForWrite(uri: Uri): OutputStream {
        val resolver = context.contentResolver
        // "wt" = write + truncate, so a smaller backup never leaves old bytes at the end.
        val stream = try {
            resolver.openOutputStream(uri, "wt")
        } catch (e: Exception) {
            Log.w(TAG, "Provider doesn't support 'wt', falling back to 'w'", e)
            resolver.openOutputStream(uri, "w")
        }
        return stream ?: throw IllegalStateException("Couldn't open the backup file.")
    }

    /** "Stix-backup.zip (Google Drive)" etc. */
    private fun describe(uri: Uri): String {
        val name = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: "backup file"
        val authority = uri.authority.orEmpty()
        val where = when {
            authority.contains("com.google.android.apps.docs") -> "Google Drive"
            authority.contains("externalstorage") || authority.contains("downloads") || authority.contains("media") -> "this phone"
            else -> null
        }
        return if (where != null) "$name ($where)" else name
    }

    companion object {
        private const val TAG = "BackupManager"
        private const val KEY_URI = "uri"
        private const val KEY_NAME = "name"
        private const val KEY_LAST = "lastBackupAt"
        private const val KEY_ERROR = "error"
        private const val KEY_DIRTY = "dirty"

        @Volatile
        private var instance: BackupManager? = null

        fun get(context: Context): BackupManager =
            instance ?: synchronized(this) {
                instance ?: BackupManager(context.applicationContext, StickerRepository.get(context)).also { instance = it }
            }
    }
}
