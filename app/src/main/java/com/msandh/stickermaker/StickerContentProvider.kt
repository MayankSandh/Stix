package com.msandh.stickermaker

import android.content.ContentProvider
import android.content.ContentValues
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor

/**
 * The interface WhatsApp uses to read sticker packs. The URI paths and column names are
 * defined by WhatsApp (see github.com/WhatsApp/stickers) and must not change.
 *
 *   content://<authority>/metadata                     all packs
 *   content://<authority>/metadata/<packId>            one pack
 *   content://<authority>/stickers/<packId>            stickers in a pack
 *   content://<authority>/stickers_asset/<packId>/<f>  a sticker or tray image file
 */
class StickerContentProvider : ContentProvider() {

    private val repo by lazy { StickerRepository.get(requireNotNull(context)) }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val path = uri.pathSegments
        val cursor = when {
            path.size == 1 && path[0] == METADATA -> packCursor(repo.packs())
            path.size == 2 && path[0] == METADATA -> packCursor(listOfNotNull(repo.pack(path[1])))
            path.size == 2 && path[0] == STICKERS -> stickerCursor(repo.pack(path[1]))
            else -> throw IllegalArgumentException("Unknown URI: $uri")
        }
        cursor.setNotificationUri(requireNotNull(context).contentResolver, uri)
        return cursor
    }

    override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor? {
        val path = uri.pathSegments
        if (path.size != 3 || path[0] != STICKERS_ASSET) return null
        val file = repo.assetFile(path[1], path[2]) ?: return null
        val pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        return AssetFileDescriptor(pfd, 0, file.length())
    }

    override fun getType(uri: Uri): String {
        val path = uri.pathSegments
        val authority = BuildConfig.CONTENT_PROVIDER_AUTHORITY
        return when {
            path.size == 1 && path[0] == METADATA -> "vnd.android.cursor.dir/vnd.$authority.$METADATA"
            path.size == 2 && path[0] == METADATA -> "vnd.android.cursor.item/vnd.$authority.$METADATA"
            path.size == 2 && path[0] == STICKERS -> "vnd.android.cursor.dir/vnd.$authority.$STICKERS"
            path.size == 3 && path[0] == STICKERS_ASSET ->
                if (path[2] == StickerRepository.TRAY_FILE) "image/png" else "image/webp"
            else -> throw IllegalArgumentException("Unknown URI: $uri")
        }
    }

    private fun packCursor(packs: List<StickerRepository.PackInfo>): MatrixCursor {
        val cursor = MatrixCursor(PACK_COLUMNS)
        for (pack in packs) {
            cursor.newRow()
                .add(pack.id)
                .add(pack.name)
                .add(PUBLISHER)
                .add(StickerRepository.TRAY_FILE)
                .add("") // android_play_store_link
                .add("") // ios_app_download_link
                .add("") // publisher email
                .add("") // publisher website
                .add("") // privacy policy
                .add("") // license agreement
                .add(pack.version.toString())
                .add(0) // whatsapp_will_not_cache_stickers
                .add(0) // animated_sticker_pack
        }
        return cursor
    }

    private fun stickerCursor(pack: StickerRepository.PackInfo?): MatrixCursor {
        val cursor = MatrixCursor(STICKER_COLUMNS)
        pack?.stickers?.forEach { cursor.addRow(arrayOf(it.file, it.emojis.joinToString(","), "")) }
        return cursor
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    companion object {
        private const val METADATA = "metadata"
        private const val STICKERS = "stickers"
        private const val STICKERS_ASSET = "stickers_asset"
        private const val PUBLISHER = "Sticker Maker"

        private val PACK_COLUMNS = arrayOf(
            "sticker_pack_identifier",
            "sticker_pack_name",
            "sticker_pack_publisher",
            "sticker_pack_icon",
            "android_play_store_link",
            "ios_app_download_link",
            "sticker_pack_publisher_email",
            "sticker_pack_publisher_website",
            "sticker_pack_privacy_policy_website",
            "sticker_pack_license_agreement_website",
            "image_data_version",
            "whatsapp_will_not_cache_stickers",
            "animated_sticker_pack",
        )

        private val STICKER_COLUMNS = arrayOf(
            "sticker_file_name",
            "sticker_emoji",
            "sticker_accessibility_text",
        )
    }
}
