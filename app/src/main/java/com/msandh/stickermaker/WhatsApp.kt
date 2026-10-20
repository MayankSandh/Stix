package com.msandh.stickermaker

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/** Talks to WhatsApp / WhatsApp Business, following WhatsApp's official sample app. */
object WhatsApp {
    const val CONSUMER = "com.whatsapp"
    const val BUSINESS = "com.whatsapp.w4b"

    fun isInstalled(context: Context, pkg: String): Boolean = try {
        @Suppress("DEPRECATION")
        context.packageManager.getApplicationInfo(pkg, 0).enabled
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    fun anyInstalled(context: Context) = isInstalled(context, CONSUMER) || isInstalled(context, BUSINESS)

    /** Whether [pkg] already has the pack. A WhatsApp that isn't installed counts as "has it". */
    fun hasPack(context: Context, packId: String, pkg: String): Boolean {
        if (!isInstalled(context, pkg)) return true
        val authority = "$pkg.provider.sticker_whitelist_check"
        @Suppress("DEPRECATION")
        context.packageManager.resolveContentProvider(authority, PackageManager.GET_META_DATA) ?: return false
        val uri = Uri.Builder()
            .scheme(ContentResolver.SCHEME_CONTENT)
            .authority(authority)
            .appendPath("is_whitelisted")
            .appendQueryParameter("authority", BuildConfig.CONTENT_PROVIDER_AUTHORITY)
            .appendQueryParameter("identifier", packId)
            .build()
        return try {
            context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                c.moveToFirst() && c.getInt(c.getColumnIndexOrThrow("result")) == 1
            } ?: false
        } catch (e: Exception) {
            false
        }
    }

    /** True when every installed WhatsApp already shows this pack. */
    fun isAdded(context: Context, packId: String): Boolean =
        anyInstalled(context) && hasPack(context, packId, CONSUMER) && hasPack(context, packId, BUSINESS)

    fun addPackIntent(packId: String, packName: String): Intent =
        Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK")
            .putExtra("sticker_pack_id", packId)
            .putExtra("sticker_pack_authority", BuildConfig.CONTENT_PROVIDER_AUTHORITY)
            .putExtra("sticker_pack_name", packName)
}
