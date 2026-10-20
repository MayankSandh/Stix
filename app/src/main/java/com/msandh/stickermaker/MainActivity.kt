package com.msandh.stickermaker

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File

/**
 * Hosts the editor UI (HTML/JS in assets/web) in a WebView served from a private
 * https://appassets.androidplatform.net origin, and wires it to native storage and WhatsApp.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge
    private lateinit var sharedDir: File

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingAddRequestId: String? = null

    @Volatile
    private var pendingSharedUrl: String? = null

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        fileCallback = null
    }

    private val addPackLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val requestId = pendingAddRequestId ?: return@registerForActivityResult
        pendingAddRequestId = null
        val status = JSONObject()
        val validationError = result.data?.getStringExtra("validation_error")
        when {
            result.resultCode == Activity.RESULT_OK -> status.put("status", "added")
            validationError != null -> status.put("status", "error").put("message", validationError)
            else -> status.put("status", "cancelled")
        }
        if (validationError != null) Log.e(TAG, "WhatsApp validation error: $validationError")
        bridge.resolve(requestId, JSONObject().put("ok", status))
    }

    private var pendingIntent: Intent? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val firstLaunch = savedInstanceState == null
        val report = CrashReporter.takeReport(this)
        if (report == null) {
            setUp(firstLaunch)
            return
        }
        // Show the report before starting anything that might crash again.
        AlertDialog.Builder(this)
            .setTitle(R.string.crash_title)
            .setMessage(R.string.crash_message)
            .setCancelable(false)
            .setPositiveButton(R.string.crash_share) { _, _ ->
                shareText(report)
                setUp(firstLaunch)
            }
            .setNegativeButton(R.string.crash_continue) { _, _ -> setUp(firstLaunch) }
            .show()
    }

    private fun shareText(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        try {
            startActivity(Intent.createChooser(send, getString(R.string.crash_share)))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No app to share the report", e)
        }
    }

    private fun setUp(firstLaunch: Boolean) {
        val repo = StickerRepository.get(this)
        sharedDir = File(cacheDir, "shared").apply { mkdirs() }

        // Draw edge to edge and pad the content away from the status/navigation bars and keyboard.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val container = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.background)) }
        webView = WebView(this)
        container.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/packs/", WebViewAssetLoader.InternalStoragePathHandler(this, repo.packsDir))
            .addPathHandler("/shared/", WebViewAssetLoader.InternalStoragePathHandler(this, sharedDir))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (e: ActivityNotFoundException) {
                    Log.w(TAG, "No app for ${request.url}")
                }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: WebChromeClient.FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickImage.launch("image/*")
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        bridge = NativeBridge(this, webView, repo)
        webView.addJavascriptInterface(bridge, "Android")

        onBackPressedDispatcher.addCallback(this) {
            webView.evaluateJavascript("window.handleBack ? window.handleBack() : false") { handled ->
                if (handled != "true") {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }

        if (firstLaunch) receiveShare(pendingIntent ?: intent)
        pendingIntent = null
        // Fetch the magic cut-out model early; it only arrives on its own for Play Store installs.
        try {
            SubjectCutout.requestModelDownload(this)
        } catch (e: Exception) {
            Log.w(TAG, "Could not request cut-out model download", e)
        }
        webView.loadUrl(START_URL)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (::bridge.isInitialized) receiveShare(intent) else pendingIntent = intent
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    /**
     * Receives an image/GIF/video file, or a text link to one, shared from another app, and
     * hands a local copy to the editor.
     */
    private fun receiveShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        val link = intent.getStringExtra(Intent.EXTRA_TEXT)?.let { MediaFetcher.firstUrl(it) }
        setIntent(Intent(this, MainActivity::class.java))
        when {
            uri != null -> {
                val extension = when (contentResolver.getType(uri)) {
                    "image/png" -> "png"
                    "image/webp" -> "webp"
                    "image/gif" -> "gif"
                    "image/heic", "image/heif" -> "heic"
                    "video/mp4" -> "mp4"
                    "video/webm" -> "webm"
                    else -> "jpg"
                }
                deliverShared {
                    val file = File(sharedDir, "shared-${System.currentTimeMillis()}.$extension")
                    contentResolver.openInputStream(uri)?.use { input ->
                        file.outputStream().use { input.copyTo(it) }
                    } ?: throw IllegalStateException(getString(R.string.no_image_shared))
                    file
                }
            }
            link != null -> {
                Toast.makeText(this, R.string.downloading, Toast.LENGTH_SHORT).show()
                deliverShared { MediaFetcher.download(link, sharedDir) }
            }
            else -> Toast.makeText(this, R.string.no_image_shared, Toast.LENGTH_LONG).show()
        }
    }

    private fun deliverShared(produce: () -> File) {
        bridge.runInBackground {
            try {
                sharedDir.listFiles()?.forEach { it.delete() }
                pendingSharedUrl = "/shared/${produce().name}"
                runOnUiThread { webView.evaluateJavascript("window.onSharedImage && window.onSharedImage()", null) }
            } catch (e: Exception) {
                Log.e(TAG, "Could not receive shared item", e)
                val message = e.message ?: getString(R.string.no_image_shared)
                runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
            }
        }
    }

    /** Used by the editor's "paste a link" button. Runs on the bridge's background thread. */
    fun downloadToShared(link: String): String {
        sharedDir.listFiles()?.forEach { it.delete() }
        val url = MediaFetcher.firstUrl(link) ?: throw IllegalArgumentException("That doesn't look like a link.")
        return "/shared/${MediaFetcher.download(url, sharedDir).name}"
    }

    /** Hands the most recently shared image to the editor once. */
    fun takeSharedImageUrl(): String? {
        val url = pendingSharedUrl
        pendingSharedUrl = null
        return url
    }

    /** Asks WhatsApp to add the pack, the same way WhatsApp's sample app does. */
    fun addToWhatsApp(requestId: String, pack: StickerRepository.PackInfo) {
        fun reply(status: String, message: String? = null) {
            val result = JSONObject().put("status", status)
            if (message != null) result.put("message", message)
            bridge.resolve(requestId, JSONObject().put("ok", result))
        }
        if (!WhatsApp.anyInstalled(this)) return reply("error", getString(R.string.whatsapp_missing))

        val inConsumer = WhatsApp.hasPack(this, pack.id, WhatsApp.CONSUMER)
        val inBusiness = WhatsApp.hasPack(this, pack.id, WhatsApp.BUSINESS)
        val intent = WhatsApp.addPackIntent(pack.id, pack.name)
        val launch = when {
            !inConsumer && !inBusiness -> Intent.createChooser(intent, getString(R.string.add_to_whatsapp))
            !inConsumer -> intent.setPackage(WhatsApp.CONSUMER)
            !inBusiness -> intent.setPackage(WhatsApp.BUSINESS)
            else -> return reply("already")
        }
        pendingAddRequestId = requestId
        try {
            addPackLauncher.launch(launch)
        } catch (e: ActivityNotFoundException) {
            pendingAddRequestId = null
            reply("error", getString(R.string.whatsapp_update))
        }
    }

    companion object {
        private const val TAG = "Stix"
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$APP_HOST/assets/web/index.html"
    }
}
