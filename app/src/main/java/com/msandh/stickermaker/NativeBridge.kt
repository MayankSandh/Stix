package com.msandh.stickermaker

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Exposed to the editor's JavaScript as `window.Android`. Each call runs on a background
 * thread and answers through `window.__nativeResolve(requestId, {ok: ...} | {error: ...})`.
 */
class NativeBridge(
    private val activity: MainActivity,
    private val webView: WebView,
    private val repo: StickerRepository,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun call(requestId: String, method: String, argsJson: String) {
        executor.execute {
            try {
                val result = dispatch(requestId, method, JSONObject(argsJson))
                if (result !== DEFERRED) resolve(requestId, JSONObject().put("ok", result ?: JSONObject.NULL))
            } catch (e: Exception) {
                Log.e(TAG, "$method failed", e)
                resolve(requestId, JSONObject().put("error", e.message ?: e.javaClass.simpleName))
            }
        }
    }

    fun resolve(requestId: String, payload: JSONObject) {
        val script = "window.__nativeResolve && window.__nativeResolve(${JSONObject.quote(requestId)}, $payload)"
        main.post { webView.evaluateJavascript(script, null) }
    }

    fun runInBackground(task: () -> Unit) = executor.execute { task() }

    private fun dispatch(requestId: String, method: String, args: JSONObject): Any? = when (method) {
        "listPacks" -> listPacks()
        "createPack" -> JSONObject().put("id", repo.createPack(args.name()).id)
        "renamePack" -> repo.renamePack(args.getString("packId"), args.name()).let { null }
        "deletePack" -> repo.deletePack(args.getString("packId")).let { null }
        "addSticker" -> {
            val dataUrl = args.getString("png")
            val png = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            repo.addSticker(args.getString("packId"), png, args.emojis()).file
        }
        "setEmojis" -> repo.setEmojis(args.getString("packId"), args.getString("file"), args.emojis()).let { null }
        "moveSticker" -> repo.moveSticker(args.getString("packId"), args.getString("file"), args.getString("toPackId")).let { null }
        "deleteSticker" -> repo.deleteSticker(args.getString("packId"), args.getString("file")).let { null }
        "addToWhatsApp" -> {
            val pack = repo.pack(args.getString("packId")) ?: throw IllegalArgumentException("Group not found")
            check(pack.stickers.size >= StickerRepository.MIN_STICKERS) {
                "WhatsApp needs at least ${StickerRepository.MIN_STICKERS} stickers in a pack."
            }
            main.post { activity.addToWhatsApp(requestId, pack) }
            DEFERRED
        }
        "takeSharedImage" -> activity.takeSharedImageUrl()
        else -> throw IllegalArgumentException("Unknown method: $method")
    }

    private fun listPacks(): JSONObject {
        val packs = JSONArray()
        for (pack in repo.packs()) {
            packs.put(JSONObject()
                .put("id", pack.id)
                .put("name", pack.name)
                .put("inWhatsApp", pack.stickers.size >= StickerRepository.MIN_STICKERS && WhatsApp.isAdded(activity, pack.id))
                .put("stickers", JSONArray().apply {
                    for (s in pack.stickers) {
                        put(JSONObject()
                            .put("file", s.file)
                            .put("emojis", JSONArray(s.emojis))
                            .put("url", "/packs/${pack.id}/${s.file}"))
                    }
                }))
        }
        return JSONObject()
            .put("packs", packs)
            .put("whatsAppInstalled", WhatsApp.anyInstalled(activity))
            .put("maxStickers", StickerRepository.MAX_STICKERS)
            .put("minStickers", StickerRepository.MIN_STICKERS)
    }

    private fun JSONObject.name(): String {
        val name = getString("name").trim().take(128)
        require(name.isNotEmpty()) { "Name can't be empty" }
        return name
    }

    private fun JSONObject.emojis(): List<String> {
        val array = optJSONArray("emojis") ?: return emptyList()
        return List(array.length()) { array.getString(it) }
    }

    companion object {
        private const val TAG = "NativeBridge"
        private val DEFERRED = Any()
    }
}
