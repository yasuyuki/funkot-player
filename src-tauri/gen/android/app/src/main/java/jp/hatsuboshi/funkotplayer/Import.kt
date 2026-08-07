package jp.hatsuboshi.funkotplayer

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/**
 * Receives files handed to the app via the system share sheet
 * (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`, see `AndroidManifest.xml`) and
 * stages them under [Context.getCacheDir]`/funkot-import/` for Rust to pick
 * up.
 *
 * This is the receiving half of [FeedbackShare]'s ZIP-out path: it only
 * copies bytes into the staging directory. Deciding *where* a staged file
 * ultimately belongs (`music_dir`) is left to Rust (`take_pending_import` in
 * `src-tauri/src/lib.rs`, via `app_dirs`) — this object never picks a
 * destination outside the cache.
 *
 * The staging directory's contents are the only state this object keeps —
 * there is deliberately no separate in-process queue of what was staged. A
 * file only ever exists there as `<name>.part` while a copy thread is still
 * writing it, or as `<name>` once that copy finished (see [onIntent]); Rust
 * reads the directory itself rather than trusting a queue that would not
 * survive the process dying between the copy finishing and Rust's next call.
 */
object Import {
    /**
     * Count of [onIntent] copy threads currently running. Lets
     * `take_pending_import` (Rust) tell "nothing to import" apart from
     * "still copying" — a cold-start call that races a multi-MB copy would
     * otherwise see an empty (or partial) staging dir and never retry, since
     * the app is already foregrounded by then and `visibilitychange` will
     * not fire again. See [hasInFlight].
     */
    private val inFlight = AtomicInteger(0)

    /**
     * Count of URIs that failed to stage since the last [takeFailed] call.
     *
     * Unlike the staging directory itself — which is deliberately the only
     * state this object keeps, precisely so a process death can't lose or
     * duplicate anything (see the class doc) — this counter *is* purely
     * in-memory and can be lost if the process dies before Rust reads it.
     * That's acceptable here because losing it only costs the user a single
     * toast's worth of "N failed" count, not a file: the failure already
     * means the bytes were never staged, so there is nothing left to recover
     * by re-reading the directory.
     */
    private val failed = AtomicInteger(0)

    /**
     * Called from both `MainActivity.onCreate` (cold start) and
     * `MainActivity.onNewIntent` (already running — `singleTask` covers both).
     * Any other `action` returns immediately, since a normal launch's
     * `ACTION_MAIN` intent goes through here too.
     */
    @JvmStatic
    fun onIntent(context: Context, intent: Intent) {
        val uris: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> {
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                if (uri != null) listOf(uri) else emptyList()
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                }
                list ?: emptyList()
            }
            else -> return
        }
        if (uris.isEmpty()) return

        // The application Context, not the Activity one `onIntent` was
        // handed: the copy below can run for as long as the share is large,
        // and an Activity can be destroyed (rotation, task trim) well before
        // it finishes, which would leak it for the copy thread's lifetime.
        val appContext = context.applicationContext

        // Must not block the calling thread (the UI thread, on both the
        // cold-start and onNewIntent paths) with a copy that can be hundreds
        // of MB.
        //
        // inFlight is incremented here, paired with the thread that is about
        // to start, and decremented in that thread's `finally` — never
        // conditionally, so a copy failure can't leave it stuck above zero.
        // The `start()` call itself is also guarded below: if it throws
        // (fails to actually launch the thread), the `finally` never runs,
        // so that path decrements explicitly instead of leaving the counter
        // stuck above zero forever.
        inFlight.incrementAndGet()
        val thread = Thread {
            try {
                val importDir = File(appContext.cacheDir, "funkot-import").apply { mkdirs() }
                uris.forEachIndexed { index, uri ->
                    val name = displayNameFor(appContext, uri, index + 1)
                    var partFile: File? = null
                    try {
                        partFile = reservePartFile(importDir, name)
                        val input = appContext.contentResolver.openInputStream(uri)
                            ?: throw IOException("openInputStream returned null for $uri")
                        input.use { source ->
                            // ponytail: cacheDir 経由の二重コピー。大量投入で遅ければ Kotlin 側で直接 music_dir へ
                            FileOutputStream(partFile).use { out -> source.copyTo(out) }
                        }
                        val finalFile = File(importDir, partFile.name.removeSuffix(".part"))
                        if (!partFile.renameTo(finalFile)) {
                            throw IOException("renameTo failed for ${partFile.absolutePath}")
                        }
                    } catch (e: Exception) {
                        // Copy (or the final rename) failed partway through:
                        // drop the partial file and move on to the next uri
                        // rather than losing the whole share. partFile can
                        // still be null here if reservePartFile itself threw
                        // (e.g. storage exhaustion) before creating anything.
                        partFile?.delete()
                        failed.incrementAndGet()
                        Log.w("funkot", "import failed for $uri: ${e.message}")
                    }
                }
            } finally {
                inFlight.decrementAndGet()
            }
        }
        try {
            thread.start()
        } catch (e: Exception) {
            // failed must be incremented before inFlight is decremented (see
            // the ordering note on takeFailed / hasInFlight below).
            failed.addAndGet(uris.size)
            inFlight.decrementAndGet()
            throw e
        }
    }

    /**
     * Whether an [onIntent] copy is still running. Rust reads this *before*
     * walking the staging directory (never after — see `take_pending_import`
     * in `lib.rs` for why that order matters), so it can tell the frontend
     * to look again shortly instead of treating "nothing finished yet" as
     * "nothing was ever shared".
     */
    @JvmStatic
    fun hasInFlight(): Boolean = inFlight.get() > 0

    /**
     * Returns the number of URIs that have failed to stage since the last
     * call to this function, resetting the count to zero (a destructive
     * read — unlike [hasInFlight], which callers may poll repeatedly). Rust
     * must call this *after* [hasInFlight] on each poll: see the ordering
     * note on [failed] and `take_pending_import` in `lib.rs`.
     */
    @JvmStatic
    fun takeFailed(): Int = failed.getAndSet(0)

    /**
     * `OpenableColumns.DISPLAY_NAME`, falling back to the basename of
     * [Uri.getLastPathSegment], then `import-<fallbackIndex>` — always run
     * through [sanitizeFileName] so a hostile display name (`/`, `..`) can
     * never place the staged file outside `importDir`.
     */
    private fun displayNameFor(context: Context, uri: Uri, fallbackIndex: Int): String {
        val queried = try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (idx >= 0) cursor.getString(idx) else null
                    } else {
                        null
                    }
                }
        } catch (e: Exception) {
            null
        }
        val candidate = queried?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.takeIf { it.isNotBlank() }
            ?: "import-$fallbackIndex"
        return sanitizeFileName(candidate).ifEmpty { "import-$fallbackIndex" }
    }

    /**
     * Strips any directory portion from `raw` (via [File.getName]) and
     * rejects the remaining `.` / `..` / empty edge cases, so the result is
     * always a plain file name that cannot walk outside its parent directory.
     */
    private fun sanitizeFileName(raw: String): String {
        val name = File(raw.replace('\\', '/')).name.trim()
        return if (name.isEmpty() || name == "." || name == "..") "" else name
    }

    /**
     * Atomically reserves `<name>.part` (or `<name> (2).part`,
     * `<name> (3).part`, … the first free one) under `dir` and returns it
     * already created, empty, ready to write into.
     *
     * Uses [File.createNewFile] (`O_EXCL` under the hood) in a loop rather
     * than picking a free name with [File.exists] and then opening it:
     * [displayNameFor] and the eventual `openInputStream` (which can block
     * for seconds against a slow content provider, e.g. a cloud backend) are
     * far enough apart in time that two closely-timed shares with the same
     * display name could otherwise both pick the same "free" name and
     * interleave writes into one file.
     */
    private fun reservePartFile(dir: File, name: String): File {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var candidateName = name
        var n = 2
        while (true) {
            val part = File(dir, "$candidateName.part")
            if (part.createNewFile()) return part
            candidateName = "$stem ($n)$ext"
            n++
        }
    }
}
