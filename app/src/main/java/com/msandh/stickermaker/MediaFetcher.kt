package com.msandh.stickermaker

import android.net.Uri
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Turns a shared link into a local media file:
 *  - direct image / GIF / video links are downloaded as-is
 *  - Google / Bing image-result links are unwrapped to the original image (imgurl / mediaurl)
 *  - web pages (Tenor, Giphy, …) are searched for their og:image / og:video media
 */
object MediaFetcher {
    private const val MAX_BYTES = 25L * 1024 * 1024
    private const val MAX_REDIRECTS = 8
    private const val USER_AGENT =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
    private val URL_REGEX = Regex("""https?://[^\s"'<>]+""")
    private val META_TAG = Regex("""<meta\b[^>]*>""", RegexOption.IGNORE_CASE)
    private val ATTR = Regex("""([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)')""")
    private val ANIMATED_EXT = Regex("""\.(gif|webp|mp4|webm)(\?|#|$)""", RegexOption.IGNORE_CASE)

    private class Response(val url: URL, val contentType: String, val bytes: ByteArray)

    fun firstUrl(text: String): String? = URL_REGEX.find(text)?.value?.trimEnd('.', ',', ')', ']', '!')

    /** Downloads the media behind [link] into [dir] and returns the file. Runs network I/O: call off the main thread. */
    fun download(link: String, dir: File): File {
        var url = unwrap(link.trim())
        repeat(3) {
            val response = get(url)
            val ext = sniffExtension(response.bytes)
            if (ext != null) {
                val file = File(dir, "shared-${System.currentTimeMillis()}.$ext")
                file.writeBytes(response.bytes)
                return file
            }
            if (!response.contentType.contains("html")) {
                throw IllegalStateException("That link isn't an image, GIF or video.")
            }
            url = findMedia(String(response.bytes, Charsets.UTF_8), response.url)
                ?: throw IllegalStateException("Couldn't find a GIF or image on that page. Try opening the GIF itself and sharing its link.")
        }
        throw IllegalStateException("Couldn't find a GIF or image at that link.")
    }

    /** Google/Bing image results link to a page; the real image is in a query parameter. */
    private fun unwrap(url: String): String {
        val uri = Uri.parse(url)
        val host = uri.host ?: return url
        if (host.contains("google.") || host.contains("bing.com")) {
            for (param in listOf("imgurl", "mediaurl")) {
                val inner = runCatching { uri.getQueryParameter(param) }.getOrNull()
                if (!inner.isNullOrBlank() && inner.startsWith("http")) return inner
            }
        }
        return url
    }

    private fun get(start: String): Response {
        var current = start
        repeat(MAX_REDIRECTS) {
            val url = URL(unwrap(current))
            require(url.protocol == "https" || url.protocol == "http") { "Only web links are supported" }
            val conn = url.openConnection() as HttpURLConnection
            try {
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("User-Agent", USER_AGENT)
                conn.setRequestProperty("Accept", "image/gif,image/webp,image/*,video/*;q=0.9,text/html;q=0.8,*/*;q=0.5")
                val code = conn.responseCode
                if (code in 300..399) {
                    val location = conn.getHeaderField("Location") ?: throw IllegalStateException("Broken redirect")
                    current = URL(url, location).toString()
                    return@repeat
                }
                if (code !in 200..299) throw IllegalStateException("The link didn't work (error $code).")
                val type = conn.contentType?.substringBefore(';')?.trim()?.lowercase().orEmpty()
                val bytes = conn.inputStream.use { readLimited(it) }
                return Response(url, type, bytes)
            } finally {
                conn.disconnect()
            }
        }
        throw IllegalStateException("Too many redirects")
    }

    private fun readLimited(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            out.write(buffer, 0, n)
            if (out.size() > MAX_BYTES) throw IllegalStateException("That file is too big (over 25 MB).")
        }
        return out.toByteArray()
    }

    /** Recognises media by its first bytes (servers often send the wrong content type). */
    private fun sniffExtension(b: ByteArray): String? {
        fun at(i: Int, s: String) = b.size >= i + s.length && String(b, i, s.length, Charsets.ISO_8859_1) == s
        return when {
            at(0, "GIF8") -> "gif"
            at(0, "RIFF") && at(8, "WEBP") -> "webp"
            at(0, "\u0089PNG") -> "png"
            b.size > 3 && (b[0].toInt() and 0xFF) == 0xFF && (b[1].toInt() and 0xFF) == 0xD8 -> "jpg"
            at(4, "ftyp") -> "mp4"
            b.size > 4 && (b[0].toInt() and 0xFF) == 0x1A && (b[1].toInt() and 0xFF) == 0x45 &&
                (b[2].toInt() and 0xFF) == 0xDF && (b[3].toInt() and 0xFF) == 0xA3 -> "webm"
            else -> null
        }
    }

    /** Picks the best media link from a page's meta tags, preferring animated formats. */
    private fun findMedia(html: String, base: URL): String? {
        val meta = mutableMapOf<String, String>()
        for (tag in META_TAG.findAll(html)) {
            val attrs = ATTR.findAll(tag.value).associate { m ->
                m.groupValues[1].lowercase() to (m.groupValues[3].ifEmpty { m.groupValues[4] })
            }
            val key = (attrs["property"] ?: attrs["name"] ?: attrs["itemprop"])?.lowercase() ?: continue
            val content = attrs["content"] ?: continue
            meta.putIfAbsent(key, decodeEntities(content))
        }
        val images = listOf("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src").mapNotNull { meta[it] }
        val videos = listOf("og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream").mapNotNull { meta[it] }
            .filter { ANIMATED_EXT.containsMatchIn(it) }
        val embedded = Regex("""imgurl=([^&"'\s]+)""").find(html)?.groupValues?.get(1)?.let { Uri.decode(it) }

        val choice = images.firstOrNull { it.contains(".gif", ignoreCase = true) }
            ?: videos.firstOrNull()
            ?: images.firstOrNull { ANIMATED_EXT.containsMatchIn(it) }
            ?: embedded
            ?: images.firstOrNull()
            ?: return null
        return URL(base, choice).toString()
    }

    private fun decodeEntities(s: String) = s
        .replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&#x2F;", "/").replace("&#47;", "/")
}
