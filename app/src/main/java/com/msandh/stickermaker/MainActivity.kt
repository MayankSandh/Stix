package com.msandh.stickermaker

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
import androidx.activity.result.IntentSenderRequest
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

    @Volatile
    private var pendingClipboardLink: String? = null
    private var pendingCleanupRequest: String? = null
    private var pendingCleanupMode: String? = null
    private var pendingAccessRequest: String? = null


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

    private var pendingBackupRequest: String? = null
    private var pendingRestoreRequest: String? = null
    private var pendingInstallRequest: String? = null
    private var restoreSource: Uri? = null

    private val createBackupFile = registerForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val requestId = pendingBackupRequest ?: return@registerForActivityResult
        pendingBackupRequest = null
        if (uri == null) return@registerForActivityResult bridge.ok(requestId, JSONObject().put("cancelled", true))
        bridge.runInBackground {
            try {
                val backup = BackupManager.get(this)
                backup.setLocation(uri)
                bridge.ok(requestId, backup.backupNow())
            } catch (e: Exception) {
                bridge.fail(requestId, e)
            }
        }
    }

    private val openBackupFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val requestId = pendingRestoreRequest ?: return@registerForActivityResult
        pendingRestoreRequest = null
        if (uri == null) return@registerForActivityResult bridge.ok(requestId, JSONObject().put("cancelled", true))
        restoreSource = uri
        bridge.runInBackground {
            try {
                bridge.ok(requestId, BackupManager.get(this).inspect(uri))
            } catch (e: Exception) {
                bridge.fail(requestId, e)
            }
        }
    }

    private val cleanupLauncher = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        val requestId = pendingCleanupRequest ?: return@registerForActivityResult
        pendingCleanupRequest = null
        val status = when {
            result.resultCode != Activity.RESULT_OK -> "cancelled"
            pendingCleanupMode == ScreenshotCleaner.DELETE -> "deleted"
            else -> "trashed"
        }
        bridge.ok(requestId, JSONObject().put("status", status))
    }

    private val photoPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        val requestId = pendingAccessRequest ?: return@registerForActivityResult
        if (ScreenshotCleaner.hasRead(this) && Build.VERSION.SDK_INT >= 31 && !ScreenshotCleaner.hasManageMedia(this)) {
            mediaManagement.launch(Intent(Settings.ACTION_REQUEST_MANAGE_MEDIA, Uri.parse("package:$packageName")))
        } else {
            pendingAccessRequest = null
            bridge.ok(requestId, ScreenshotCleaner.status(this))
        }
    }

    private val mediaManagement = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val requestId = pendingAccessRequest ?: return@registerForActivityResult
        pendingAccessRequest = null
        bridge.ok(requestId, ScreenshotCleaner.status(this))
    }

    private val allowInstalls = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val requestId = pendingInstallRequest ?: return@registerForActivityResult
        if (packageManager.canRequestPackageInstalls()) {
            startUpdate(requestId)
        } else {
            pendingInstallRequest = null
            bridge.ok(requestId, JSONObject().put("status", "denied"))
        }
    }

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
        BackupManager.get(this) // starts keeping the backup file up to date
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
                    // Note the gallery screenshot now, while Stix still has access to it.
                    val shot = if (Build.VERSION.SDK_INT >= 30) {
                        runCatching { ScreenshotCleaner.findScreenshot(this, uri) }
                            .onFailure { Log.w(TAG, "Couldn't identify shared screenshot", it) }
                            .getOrNull()
                    } else {
                        null
                    }
                    if (shot != null) ScreenshotCleaner.remember(this, file.name, shot) else inheritLensScreenshot(file)
                    file
                }
            }
            link != null -> {
                Toast.makeText(this, R.string.downloading, Toast.LENGTH_SHORT).show()
                deliverShared { MediaFetcher.download(link, sharedDir).also { inheritLensScreenshot(it) } }
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
        val file = MediaFetcher.download(url, sharedDir)
        inheritLensScreenshot(file)
        return "/shared/${file.name}"
    }

    /** A GIF/link that arrives during a Lens search belongs to the screenshot being searched. */
    private fun inheritLensScreenshot(file: File) {
        ScreenshotCleaner.lensShot(this)?.let { ScreenshotCleaner.remember(this, file.name, it) }
    }

    /**
     * Sends the boxed area to Google Lens (via the Google app), falling back to the Share menu.
     * Remembers the clipboard so a link copied in Lens can be offered on return.
     */
    fun searchOnLens(requestId: String, png: ByteArray, sourceUrl: String?) {
        try {
            val dir = File(cacheDir, "lens").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, "lens-${System.currentTimeMillis()}.png").apply { writeBytes(png) }
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "$packageName.files", file)
            val send = Intent(Intent.ACTION_SEND)
                .setType("image/png")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = android.content.ClipData.newRawUri("", uri)
            val shot = sourceUrl?.let { ScreenshotCleaner.lookup(this, it.substringAfterLast('/')) }
            ScreenshotCleaner.startLens(this, shot, clipboardText())
            var via = "lens"
            val launched = LENS_APPS.any { pkg ->
                try {
                    startActivity(Intent(send).setPackage(pkg))
                    true
                } catch (e: ActivityNotFoundException) {
                    false
                }
            }
            if (!launched) {
                via = "share"
                startActivity(Intent.createChooser(send, getString(R.string.search_on_lens)))
            }
            bridge.ok(requestId, JSONObject().put("via", via))
        } catch (e: Exception) {
            bridge.fail(requestId, e)
        }
    }

    private fun clipboardText(): String? = try {
        val clip = (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).primaryClip
        if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(this)?.toString() else null
    } catch (e: Exception) {
        Log.w(TAG, "Can't read clipboard", e)
        null
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Android only lets the focused app read the clipboard, so check here, and only after a Lens search.
        if (!hasFocus || !::webView.isInitialized || !ScreenshotCleaner.lensActive(this)) return
        val text = clipboardText() ?: return
        if (!ScreenshotCleaner.isNewClipboard(this, text)) return
        pendingClipboardLink = MediaFetcher.firstUrl(text) ?: return
        // If the page is still loading (Stix was restarted), it picks the link up on startup instead.
        webView.evaluateJavascript("window.onClipboardLink && window.onClipboardLink()", null)
    }

    /** Hands a link copied during a Lens search to the editor once. */
    fun takeClipboardLink(): String? {
        val link = pendingClipboardLink
        pendingClipboardLink = null
        return link
    }

    /** Sets up prompt-free cleanup: photo access, then the "Media management" switch. Asked once. */
    fun grantScreenshotAccess(requestId: String) {
        ScreenshotCleaner.markSetupOffered(this)
        pendingAccessRequest = requestId
        when {
            !ScreenshotCleaner.hasRead(this) -> photoPermission.launch(ScreenshotCleaner.readPermission())
            Build.VERSION.SDK_INT >= 31 && !ScreenshotCleaner.hasManageMedia(this) ->
                mediaManagement.launch(Intent(Settings.ACTION_REQUEST_MANAGE_MEDIA, Uri.parse("package:$packageName")))
            else -> {
                pendingAccessRequest = null
                bridge.ok(requestId, ScreenshotCleaner.status(this))
            }
        }
    }

    /**
     * Called after a sticker was saved from a shared image. Replies with status:
     * kept | skipped (not a screenshot / unsupported) | setup (offer one-time access first) |
     * trashed | deleted | cancelled.
     */
    fun cleanupShared(requestId: String, url: String, allowPrompt: Boolean) {
        fun reply(status: String) = bridge.ok(requestId, JSONObject().put("status", status))
        val mode = ScreenshotCleaner.mode(this)
        val shot = ScreenshotCleaner.lookup(this, url.substringAfterLast('/'))
            ?: return reply("skipped")
        if (mode == ScreenshotCleaner.KEEP) {
            ScreenshotCleaner.forget(this, shot)
            return reply("kept")
        }
        if (Build.VERSION.SDK_INT < 30) return reply("skipped")
        val silent = ScreenshotCleaner.hasSilentAccess(this)
        if (!silent && !allowPrompt && !ScreenshotCleaner.setupOffered(this)) return reply("setup")
        try {
            pendingCleanupRequest = requestId
            pendingCleanupMode = mode
            cleanupLauncher.launch(IntentSenderRequest.Builder(ScreenshotCleaner.request(this, shot, mode)).build())
            ScreenshotCleaner.forget(this, shot)
        } catch (e: Exception) {
            // Most likely the screenshot was already deleted by hand.
            Log.w(TAG, "Couldn't clean up $shot", e)
            pendingCleanupRequest = null
            ScreenshotCleaner.forget(this, shot)
            reply("skipped")
        }
    }

    /** Hands the most recently shared image to the editor once. */
    fun takeSharedImageUrl(): String? {
        val url = pendingSharedUrl
        pendingSharedUrl = null
        return url
    }

    fun chooseBackupLocation(requestId: String) {
        pendingBackupRequest = requestId
        createBackupFile.launch("Stix-backup.zip")
    }

    fun pickRestoreFile(requestId: String) {
        pendingRestoreRequest = requestId
        openBackupFile.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
    }

    /** Runs on the bridge thread after the user confirmed the restore. */
    fun applyRestore(): JSONObject = BackupManager.get(this).restore(restoreSource).also { restoreSource = null }

    fun installUpdate(requestId: String) {
        pendingInstallRequest = requestId
        if (!packageManager.canRequestPackageInstalls()) {
            // Android asks once: "Allow Stix to install unknown apps".
            allowInstalls.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            return
        }
        startUpdate(requestId)
    }

    private fun startUpdate(requestId: String) {
        pendingInstallRequest = null
        bridge.runInBackground {
            try {
                val info = Updater.fetchInfo() ?: throw IllegalStateException("No update is available.")
                val apk = Updater.download(this, info) { pct ->
                    runOnUiThread { webView.evaluateJavascript("window.onUpdateProgress && window.onUpdateProgress($pct)", null) }
                }
                runOnUiThread {
                    try {
                        startActivity(Updater.installIntent(this, apk))
                        bridge.ok(requestId, JSONObject().put("status", "installing"))
                    } catch (e: Exception) {
                        bridge.fail(requestId, e)
                    }
                }
            } catch (e: Exception) {
                bridge.fail(requestId, e)
            }
        }
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
        /** Google app (hosts Lens for shared images), then the standalone Lens app. */
        private val LENS_APPS = listOf("com.google.android.googlequicksearchbox", "com.google.ar.lens")
        private const val START_URL = "https://$APP_HOST/assets/web/index.html"
    }
}
