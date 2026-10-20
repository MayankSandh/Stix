package com.msandh.stickermaker

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.math.roundToInt

/**
 * "Magic cut-out": finds the main subject with ML Kit Subject Segmentation (runs on the phone,
 * model provided by Google Play services) and returns a soft alpha mask the editor applies.
 */
object SubjectCutout {
    private val segmenter by lazy {
        SubjectSegmentation.getClient(
            SubjectSegmenterOptions.Builder()
                .enableForegroundConfidenceMask()
                .build(),
        )
    }

    /** @return a PNG data URL, same size as the input: white pixels whose alpha = subject confidence. */
    fun maskDataUrl(context: Context, imageBytes: ByteArray): String {
        val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
            ?: throw IllegalArgumentException("Could not read the image")
        val result = try {
            Tasks.await(segmenter.process(InputImage.fromBitmap(bitmap, 0)), 60, TimeUnit.SECONDS)
        } catch (e: ExecutionException) {
            val cause = e.cause
            if (cause is MlKitException && cause.errorCode == MlKitException.UNAVAILABLE) {
                requestModelDownload(context)
                throw IllegalStateException("The magic cut-out tool is still downloading. Try again in a minute.")
            }
            throw IllegalStateException("Magic cut-out failed: ${cause?.message ?: e.message}")
        } catch (e: TimeoutException) {
            throw IllegalStateException("Magic cut-out took too long. Try a smaller crop.")
        }

        val mask = result.foregroundConfidenceMask
            ?: throw IllegalStateException("Magic cut-out couldn't find a subject.")
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        var subjectPixels = 0
        mask.rewind()
        for (i in pixels.indices) {
            val confidence = mask.get()
            if (confidence > 0.5f) subjectPixels++
            val alpha = (confidence * 255f).roundToInt().coerceIn(0, 255)
            pixels[i] = (alpha shl 24) or 0x00FFFFFF
        }
        if (subjectPixels < pixels.size / 500) {
            throw IllegalStateException("Couldn't find a clear subject here. Try cropping closer to it.")
        }

        val out = ByteArrayOutputStream()
        Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
            .compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    /** Asks Google Play services to fetch the model now (normally it arrives after install). */
    fun requestModelDownload(context: Context) {
        ModuleInstall.getClient(context)
            .installModules(ModuleInstallRequest.newBuilder().addApi(segmenter).build())
    }
}
