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
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Stores sticker packs in the app's private storage:
 *   files/packs.json              pack names, sticker order and emojis
 *   files/packs/<packId>/<name>.webp  512x512 stickers (still <= 100 KB, animated <= 500 KB)
 *   files/packs/<packId>/<name>.png   first frame of an animated sticker (used for the tray icon)
 *   files/packs/<packId>/tray.png 96x96 pack icon shown in WhatsApp's sticker tray
 *
 * WhatsApp doesn't allow still and animated stickers in the same pack, so a pack's kind is
 * fixed by its first sticker and reset when it becomes empty.
 */
class StickerRepository private constructor(private val context: Context) {

    data class StickerInfo(val file: String, val emojis: List<String>)

    data class PackInfo(
        val id: String,
        val name: String,
        val version: Int,
        /** null while the pack is empty */
        val animated: Boolean?,
        val stickers: List<StickerInfo>,
    )

    private class Sticker(val file: String, var emojis: List<String>, val createdAt: Long)

    private class Pack(
        val id: String,
        var name: String,
        val createdAt: Long,
        var version: Int,
        var animated: Boolean?,
        val stickers: MutableList<Sticker>,
    )

    data class BackupSummary(val createdAt: Long, val packs: Int, val stickers: Int)

    val packsDir = File(context.filesDir, "packs").apply { mkdirs() }
    private val index = AtomicFile(File(context.filesDir, "packs.json"))
    private val packs = mutableListOf<Pack>()

    /**
     * Set when packs.json couldn't be read. While set, nothing is written, so a reading bug can
     * never wipe the user's stickers.
     */
    @Volatile
    var loadError: String? = null
        private set

    /** Called after every saved change (used to keep the backup file up to date). */
    @Volatile
    var onChanged: (() -> Unit)? = null

    init {
        load()
    }

    @Synchronized
    fun packs(): List<PackInfo> = packs.map { it.info() }

    @Synchronized
    fun pack(id: String): PackInfo? = find(id)?.info()

    @Synchronized
    fun createPack(name: String): PackInfo {
        val pack = Pack(UUID.randomUUID().toString(), name, System.currentTimeMillis(), 1, null, mutableListOf())
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
            check(pack.animated != true) { "“${pack.name}” is a GIF pack. Save still stickers to another group." }
            return insert(pack, webp, null, emojis, animated = false)
        }
    }

    /** Stores an animated WebP made by the editor, plus a PNG of its first frame for the tray icon. */
    fun addAnimatedSticker(packId: String, webp: ByteArray, previewPng: ByteArray, emojis: List<String>): StickerInfo {
        validateAnimatedWebp(webp)
        requireNotNull(BitmapFactory.decodeByteArray(previewPng, 0, previewPng.size)) { "Could not read the preview image" }
        synchronized(this) {
            val pack = packOrThrow(packId)
            check(pack.animated != false) { "“${pack.name}” has still stickers. Save GIF stickers to another group." }
            return insert(pack, webp, previewPng, emojis, animated = true)
        }
    }

    private fun insert(pack: Pack, webp: ByteArray, previewPng: ByteArray?, emojis: List<String>, animated: Boolean): StickerInfo {
        check(pack.stickers.size < MAX_STICKERS) { "This group already has $MAX_STICKERS stickers, the most WhatsApp allows." }
        val name = "s${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(6)}.webp"
        val dir = File(packsDir, pack.id).apply { mkdirs() }
        File(dir, name).writeBytes(webp)
        if (previewPng != null) File(dir, previewName(name)).writeBytes(previewPng)
        val sticker = Sticker(name, cleanEmojis(emojis), System.currentTimeMillis())
        pack.stickers.add(sticker)
        pack.animated = animated
        changed(pack)
        return StickerInfo(sticker.file, sticker.emojis)
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
        check(to.animated == null || to.animated == from.animated) { "GIF and still stickers can't share a pack in WhatsApp." }
        val sticker = from.stickers.firstOrNull { it.file == file } ?: throw IllegalArgumentException("Sticker not found")
        val toDir = File(packsDir, to.id).apply { mkdirs() }
        val fromDir = File(packsDir, from.id)
        for (name in listOf(file, previewName(file))) {
            val source = File(fromDir, name)
            if (!source.exists()) continue
            val target = File(toDir, name)
            if (!source.renameTo(target)) {
                source.copyTo(target, overwrite = true)
                source.delete()
            }
        }
        from.stickers.remove(sticker)
        to.stickers.add(sticker)
        to.animated = from.animated
        if (from.stickers.isEmpty()) from.animated = null
        changed(from, save = false)
        changed(to)
    }

    @Synchronized
    fun deleteSticker(packId: String, file: String) {
        val pack = packOrThrow(packId)
        if (pack.stickers.removeAll { it.file == file }) {
            File(File(packsDir, pack.id), file).delete()
            File(File(packsDir, pack.id), previewName(file)).delete()
            if (pack.stickers.isEmpty()) pack.animated = null
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

    // ---- backup ----

    /** Writes every pack and sticker into one zip. Holds the lock so the snapshot is consistent. */
    @Synchronized
    fun writeBackup(out: OutputStream) {
        ZipOutputStream(out.buffered()).use { zip ->
            fun put(name: String, bytes: ByteArray) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
            val manifest = JSONObject()
                .put("app", "Stix")
                .put("format", BACKUP_FORMAT)
                .put("createdAt", System.currentTimeMillis())
                .put("packs", packs.size)
                .put("stickers", packs.sumOf { it.stickers.size })
            put(BACKUP_MANIFEST, manifest.toString().toByteArray(Charsets.UTF_8))
            put(INDEX_NAME, indexJson().toString().toByteArray(Charsets.UTF_8))
            for (pack in packs) {
                val dir = File(packsDir, pack.id)
                for (sticker in pack.stickers) {
                    for (name in listOf(sticker.file, previewName(sticker.file))) {
                        val file = File(dir, name)
                        if (!file.isFile) continue
                        zip.putNextEntry(ZipEntry("packs/${pack.id}/$name"))
                        file.inputStream().use { it.copyTo(zip) }
                        zip.closeEntry()
                    }
                }
            }
        }
    }

    /** Reads what a backup file contains, without changing anything. */
    fun readBackupSummary(zipFile: File): BackupSummary {
        ZipFile(zipFile).use { zip ->
            val entry = zip.getEntry(BACKUP_MANIFEST) ?: throw IllegalArgumentException("This isn't a Stix backup file.")
            val manifest = JSONObject(zip.getInputStream(entry).use { String(it.readBytes(), Charsets.UTF_8) })
            require(manifest.optString("app") == "Stix") { "This isn't a Stix backup file." }
            require(manifest.optInt("format") <= BACKUP_FORMAT) { "This backup was made by a newer Stix. Update the app first." }
            return BackupSummary(manifest.optLong("createdAt"), manifest.optInt("packs"), manifest.optInt("stickers"))
        }
    }

    /** Replaces all current packs with the ones in the backup. */
    @Synchronized
    fun restoreBackup(zipFile: File) {
        readBackupSummary(zipFile)
        val staging = File(context.filesDir, "restore-staging")
        staging.deleteRecursively()
        staging.mkdirs()
        try {
            ZipFile(zipFile).use { zip ->
                for (entry in zip.entries()) {
                    val name = entry.name
                    if (entry.isDirectory || name.contains("..")) continue
                    // Only expected paths are extracted; anything else (including path tricks) is ignored.
                    if (name != INDEX_NAME && !BACKUP_FILE.matches(name)) continue
                    val target = File(staging, name)
                    target.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { input -> target.outputStream().use { input.copyTo(it) } }
                }
            }
            val indexFile = File(staging, INDEX_NAME)
            require(indexFile.isFile) { "This backup file is incomplete." }
            val restored = parse(JSONObject(indexFile.readText(Charsets.UTF_8)))

            packsDir.listFiles()?.forEach { it.deleteRecursively() }
            File(staging, "packs").listFiles()?.forEach { dir -> dir.renameTo(File(packsDir, dir.name)) }
            packs.clear()
            packs.addAll(restored)
            for (pack in packs) {
                pack.stickers.removeAll { !File(File(packsDir, pack.id), it.file).isFile }
                if (pack.stickers.isEmpty()) pack.animated = null
                pack.version++ // make WhatsApp re-read packs it already knows
                writeTray(pack)
            }
            save()
        } finally {
            staging.deleteRecursively()
        }
    }

    // ---- internals ----

    private fun find(id: String) = packs.firstOrNull { it.id == id }

    private fun packOrThrow(id: String) = find(id) ?: throw IllegalArgumentException("Group not found")

    private fun Pack.info() = PackInfo(id, name, version, animated, stickers.map { StickerInfo(it.file, it.emojis) })

    private fun previewName(file: String) = file.removeSuffix(".webp") + ".png"

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
        val preview = File(dir, previewName(first.file))
        val source = if (preview.exists()) preview else File(dir, first.file)
        val bitmap = BitmapFactory.decodeFile(source.path) ?: return
        val icon = Bitmap.createScaledBitmap(bitmap, TRAY_SIZE, TRAY_SIZE, true)
        tray.outputStream().use { icon.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun load() {
        if (!index.baseFile.exists()) return
        try {
            packs.addAll(parse(JSONObject(String(index.readFully(), Charsets.UTF_8))))
        } catch (e: Exception) {
            Log.e("StickerRepository", "Could not read packs.json", e)
            loadError = "Stix couldn't read your saved stickers (${e.message}). They haven't been changed. " +
                "Please send a report so this can be fixed."
        }
    }

    private fun parse(root: JSONObject): List<Pack> {
        val result = mutableListOf<Pack>()
        val list = root.optJSONArray("packs") ?: return result
        for (i in 0 until list.length()) {
            val p = list.getJSONObject(i)
            val stickers = p.optJSONArray("stickers") ?: JSONArray()
            val pack = Pack(
                id = p.getString("id"),
                name = p.optString("name", "Stickers"),
                createdAt = p.optLong("createdAt"),
                version = p.optInt("version", 1),
                // isNull() covers both a missing key and an explicit null ("kind not decided yet").
                animated = if (p.isNull("animated")) null else p.optBoolean("animated"),
                stickers = MutableList(stickers.length()) { j ->
                    val s = stickers.getJSONObject(j)
                    val emojis = s.optJSONArray("emojis") ?: JSONArray()
                    Sticker(
                        file = s.getString("file"),
                        emojis = cleanEmojis(List(emojis.length()) { k -> emojis.optString(k) }),
                        createdAt = s.optLong("createdAt"),
                    )
                },
            )
            // Packs saved before GIF support have no kind: work it out from the files.
            if (pack.animated == null && pack.stickers.isNotEmpty()) {
                pack.animated = File(File(packsDir, pack.id), previewName(pack.stickers.first().file)).exists()
            }
            result.add(pack)
        }
        return result
    }

    private fun indexJson(): JSONObject = JSONObject().put("packs", JSONArray().apply {
            for (pack in packs) {
                put(JSONObject()
                    .put("id", pack.id)
                    .put("name", pack.name)
                    .put("createdAt", pack.createdAt)
                    .put("version", pack.version)
                    .put("animated", pack.animated ?: JSONObject.NULL)
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

    private fun save() {
        loadError?.let { throw IllegalStateException(it) }
        val root = indexJson()
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
        onChanged?.invoke()
    }

    companion object {
        const val TRAY_FILE = "tray.png"
        private const val INDEX_NAME = "packs.json"
        private const val BACKUP_MANIFEST = "stix-backup.json"
        private const val BACKUP_FORMAT = 1
        private val BACKUP_FILE = Regex("^packs/[A-Za-z0-9-]{1,64}/[A-Za-z0-9_.-]{1,100}$")
        const val MIN_STICKERS = 3
        const val MAX_STICKERS = 30
        private const val STICKER_SIZE = 512
        private const val TRAY_SIZE = 96
        private const val MAX_STICKER_BYTES = 100 * 1024
        private const val MAX_ANIMATED_BYTES = 500 * 1024
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

        /** Checks the WhatsApp rules we can verify cheaply: size, WebP container, animation flag, 512x512. */
        private fun validateAnimatedWebp(bytes: ByteArray) {
            require(bytes.size <= MAX_ANIMATED_BYTES) { "GIF sticker is larger than WhatsApp's 500 KB limit" }
            fun fourcc(at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
            fun u24(at: Int) = (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8) or ((bytes[at + 2].toInt() and 0xFF) shl 16)
            require(bytes.size > 30 && fourcc(0) == "RIFF" && fourcc(8) == "WEBP" && fourcc(12) == "VP8X") { "Not an animated WebP" }
            require(bytes[20].toInt() and 0x02 != 0) { "WebP is not animated" }
            require(u24(24) + 1 == STICKER_SIZE && u24(27) + 1 == STICKER_SIZE) { "GIF sticker must be 512x512" }
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
