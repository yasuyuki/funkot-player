package jp.hatsuboshi.funkotplayer

import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Opens the system share sheet for a staged feedback ZIP.
 *
 * Called from Rust via JNI (`share_feedback` → `shareFrom`). The path must
 * live under [Context.getCacheDir] so the existing FileProvider
 * `<cache-path>` in `file_paths.xml` can grant a content URI.
 */
object FeedbackShare {
    @JvmStatic
    fun shareFrom(context: Context, absolutePath: String) {
        val file = File(absolutePath)
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            clipData = ClipData.newRawUri("", uri)
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "意見を送る").apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(chooser)
    }
}
