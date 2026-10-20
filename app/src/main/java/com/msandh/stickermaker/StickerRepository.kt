package com.msandh.stickermaker

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import android.os.Build
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Stores sticker packs in the app's private storage:
 *   files/packs.json              pack names, sticker order and emojis
 *   files/packs/<packId>/<name>.webp  512x512 stickers (<= 100 KB each)
 *   files/packs/<packId>/tray.png 96x96 pack icon shown in WhatsApp's sticker tray
 */
class StickerRepository private constructor(private val context: Context) {

    data class StickerInfo(val file: String, val emojis: List<String>)

    data class PackInfo(
        val id: String,
        val name: String,
        val version: Int,
        val stickers: List<StickerInfo>,
    )

    private class Sticker(val file: String, var emojis: List<String>, val createdAt: Long)

    private class Pack(
        val id: String,
        var name: String,
        val createdAt: Long,
        var version: Int,
        val stickers: MutableList<Sticker>,
    )

    val packsDir = File(context.filesDir, "packs").apply { mkdirs() }
    private val index = AtomicFile(File(context.filesDir, "packs.json"))
    private val packs = mutableListOf<Pack>()

    init {
        load()
    }

    @Synchronized
    fun packs(): List<PackInfo> = packs.map { it.info() }

    @Synchronized
    fun pack(id: String): PackInfo? = find(id)?.info()

    @Synchronized
    fun createPack(name: String): PackInfo {
        val pack = Pack(UUID.randomUUID().toString(), name, System.currentTimeMillis(), 1, mutableListOf())
        packs.add(pack)
        save()
        return pack.info()
    }

    @Synchronized
    fun renamePack(id: String, name: String) {
        val pack = packOrThrow(id)
        pack.name = name
        pack.version++
        save()
    }

    @Synchronized
    fun deletePack(id: String) {
        val pack = packOrThrow(id)
        packs.remove(pack)
        File(packsDir, pack.id).deleteRecursively()
        save()
    }

    /** Converts a PNG from the editor into a WhatsApp-ready WebP and appends it to the pack. */
    fun addSticker(packId: String, png: ByteArray, emojis: List<String>): StickerInfo {
        val webp = encodeSticker(png) // slow part, done outside the lock
        synchronized(this) {
            val pack = packOrThrow(packId)
            check(pack.stickers.size < MAX_STICKERS) { "This group already has $MAX_STICKERS stickers, the most WhatsApp allows." }
            val name = "s${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(6)}.webp"
            val dir = File(packsDir, pack.id).apply { mkdirs() }
            File(dir, name).writeBytes(webp)
            val sticker = Sticker(name, cleanEmojis(emojis), System.currentTimeMillis())
            pack.stickers.add(sticker)
            changed(pack)
            return StickerInfo(sticker.file, sticker.emojis)
        }
    }

    @Synchronized
    fun setEmojis(packId: String, file: String, emojis: List<String>) {
        val pack = packOrThrow(packId)
        val sticker = pack.stickers.firstOrNull { it.file == file } ?: throw IllegalArgumentException("Sticker not found")
        sticker.emojis = cleanEmojis(emojis)
        pack.version++
        save()
    }

    @Synchronized
    fun moveSticker(packId: String, file: String, toPackId: String) {
        if (packId == toPackId) return
        val from = packOrThrow(packId)
        val to = packOrThrow(toPackId)
        check(to.stickers.size < MAX_STICKERS) { "“${to.name}” already has $MAX_STICKERS stickers." }
        val sticker = from.stickers.firstOrNull { it.file == file } ?: throw IllegalArgumentException("Sticker not found")
        val target = File(File(packsDir, to.id).apply { mkdirs() }, file)
        val source = File(File(packsDir, from.id), file)
        if (!source.renameTo(target)) {
            source.copyTo(target, overwrite = true)
            source.delete()
        }
        from.stickers.remove(sticker)
        to.stickers.add(sticker)
        changed(from, save = false)
        changed(to)
    }

    @Synchronized
    fun deleteSticker(packId: String, file: String) {
        val pack = packOrThrow(packId)
        if (pack.stickers.removeAll { it.file == file }) {
            File(File(packsDir, pack.id), file).delete()
            changed(pack)
        }
    }

    /** A file WhatsApp may read: the pack's tray icon or one of its stickers. Null otherwise. */
    @Synchronized
    fun assetFile(packId: String, name: String): File? {
        val pack = find(packId) ?: return null
        val allowed = name == TRAY_FILE || pack.stickers.any { it.file == name }
        if (!allowed) return null
        return File(File(packsDir, pack.id), name).takeIf { it.isFile }
    }

    // ---- internals ----

    private fun find(id: String) = packs.firstOrNull { it.id == id }

    private fun packOrThrow(id: String) = find(id) ?: throw IllegalArgumentException("Group not found")

    private fun Pack.info() = PackInfo(id, name, version, stickers.map { StickerInfo(it.file, it.emojis) })

    /** Bumps the version so WhatsApp re-reads the pack, refreshes the tray icon and saves. */
    private fun changed(pack: Pack, save: Boolean = true) {
        pack.version++
        writeTray(pack)
        if (save) save()
    }

    private fun writeTray(pack: Pack) {
        val dir = File(packsDir, pack.id)
        val tray = File(dir, TRAY_FILE)
        val first = pack.stickers.firstOrNull()
        if (first == null) {
            tray.delete()
            return
        }
        val bitmap = BitmapFactory.decodeFile(File(dir, first.file).path) ?: return
        val icon = Bitmap.createScaledBitmap(bitmap, TRAY_SIZE, TRAY_SIZE, true)
        tray.outputStream().use { icon.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun load() {
        if (!index.baseFile.exists()) return
        val root = JSONObject(String(index.readFully(), Charsets.UTF_8))
        val list = root.optJSONArray("packs") ?: return
        for (i in 0 until list.length()) {
            val p = list.getJSONObject(i)
            val stickers = p.getJSONArray("stickers")
            packs.add(
                Pack(
                    id = p.getString("id"),
                    name = p.getString("name"),
                    createdAt = p.getLong("createdAt"),
                    version = p.getInt("version"),
                    stickers = MutableList(stickers.length()) { j ->
                        val s = stickers.getJSONObject(j)
                        val emojis = s.getJSONArray("emojis")
                        Sticker(
                            file = s.getString("file"),
                            emojis = List(emojis.length()) { k -> emojis.getString(k) },
                            createdAt = s.getLong("createdAt"),
                        )
                    },
                ),
            )
        }
    }

    private fun save() {
        val root = JSONObject().put("packs", JSONArray().apply {
            for (pack in packs) {
                put(JSONObject()
                    .put("id", pack.id)
                    .put("name", pack.name)
                    .put("createdAt", pack.createdAt)
                    .put("version", pack.version)
                    .put("stickers", JSONArray().apply {
                        for (s in pack.stickers) {
                            put(JSONObject()
                                .put("file", s.file)
                                .put("emojis", JSONArray(s.emojis))
                                .put("createdAt", s.createdAt))
                        }
                    }))
            }
        })
        val out = index.startWrite()
        try {
            out.write(root.toString().toByteArray(Charsets.UTF_8))
            index.finishWrite(out)
        } catch (e: Exception) {
            index.failWrite(out)
            throw e
        }
        // Tell WhatsApp (if it is watching) that pack data changed.
        context.contentResolver.notifyChange(METADATA_URI, null)
    }

    companion object {
        const val TRAY_FILE = "tray.png"
        const val MIN_STICKERS = 3
        const val MAX_STICKERS = 30
        private const val STICKER_SIZE = 512
        private const val TRAY_SIZE = 96
        private const val MAX_STICKER_BYTES = 100 * 1024
        private const val DEFAULT_EMOJI = "😀"

        val METADATA_URI: Uri = Uri.Builder()
            .scheme(ContentResolver.SCHEME_CONTENT)
            .authority(BuildConfig.CONTENT_PROVIDER_AUTHORITY)
            .appendPath("metadata")
            .build()

        @Volatile
        private var instance: StickerRepository? = null

        fun get(context: Context): StickerRepository =
            instance ?: synchronized(this) {
                instance ?: StickerRepository(context.applicationContext).also { instance = it }
            }

        /** WhatsApp requires 1 to 3 emojis per sticker. */
        fun cleanEmojis(emojis: List<String>): List<String> {
            val cleaned = emojis.map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(3)
            return cleaned.ifEmpty { listOf(DEFAULT_EMOJI) }
        }

        private fun encodeSticker(png: ByteArray): ByteArray {
            val decoded = BitmapFactory.decodeByteArray(png, 0, png.size)
                ?: throw IllegalArgumentException("Could not read the sticker image")
            val bitmap = fitTo512(decoded)
            @Suppress("DEPRECATION")
            val format = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
            for (quality in intArrayOf(90, 80, 70, 60, 50, 40, 30, 20, 10)) {
                val out = ByteArrayOutputStream()
                bitmap.compress(format, quality, out)
                if (out.size() <= MAX_STICKER_BYTES) return out.toByteArray()
            }
            throw IllegalStateException("Could not make the sticker small enough for WhatsApp")
        }

        private fun fitTo512(src: Bitmap): Bitmap {
            if (src.width == STICKER_SIZE && src.height == STICKER_SIZE && src.config == Bitmap.Config.ARGB_8888) return src
            val out = Bitmap.createBitmap(STICKER_SIZE, STICKER_SIZE, Bitmap.Config.ARGB_8888)
            val scale = STICKER_SIZE.toFloat() / max(src.width, src.height)
            val w = (src.width * scale).roundToInt()
            val h = (src.height * scale).roundToInt()
            val left = (STICKER_SIZE - w) / 2f
            val top = (STICKER_SIZE - h) / 2f
            Canvas(out).drawBitmap(src, null, RectF(left, top, left + w, top + h), Paint(Paint.FILTER_BITMAP_FLAG))
            return out
        }
    }
}
