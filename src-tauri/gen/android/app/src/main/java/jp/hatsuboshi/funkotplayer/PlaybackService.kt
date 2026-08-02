package jp.hatsuboshi.funkotplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.widget.Toast

/**
 * Foreground service whose only job is to keep this process foreground-
 * privileged while music plays in the background, plus own the MediaSession
 * that gives the player transport controls.
 *
 * It plays no audio itself: the cpal output stream lives on a dedicated Rust
 * thread started from the Tauri `start` command and keeps running for as long
 * as the process does. Without a `mediaPlayback`-typed foreground service,
 * Android mutes that stream (`mutedState:opControlAudio`) the moment the app
 * leaves the screen or the display turns off, even though the stream stays
 * alive.
 *
 * The MediaSession is not decoration. A plain notification, even an ongoing one
 * with actions, lands in the silent section of the shade and gets collapsed into
 * the icon strip at the bottom, where it is effectively invisible. A MediaStyle
 * notification backed by a session is what puts the controls in the media area
 * of the shade and on the lock screen, which is where a music app belongs.
 */
class PlaybackService : Service() {
    companion object {
        private const val CHANNEL_ID = "playback"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_TOGGLE = "jp.hatsuboshi.funkotplayer.action.TOGGLE"
        private const val ACTION_NEXT = "jp.hatsuboshi.funkotplayer.action.NEXT"
        private const val ACTION_FLAG = "jp.hatsuboshi.funkotplayer.action.FLAG"
        private const val ACTION_SYNC = "jp.hatsuboshi.funkotplayer.action.SYNC"

        /** Must match the `action` values handled in `onNativeControl` (Rust). */
        private const val CONTROL_TOGGLE = 0
        private const val CONTROL_NEXT = 1
        private const val CONTROL_QUERY = 2
        private const val CONTROL_FLAG = 3

        /** Must match Rust `Phase::Disconnected as u8`. */
        private const val PHASE_DISCONNECTED = 6

        private const val FLAG_FEEDBACK_MS = 4_000L

        init {
            // Same native library the rest of the app loads (see generated
            // Rust.kt); loading it again here is a no-op if it is already
            // resident. Kept as a cheap guarantee that `onNativeControl`
            // resolves even if this class is touched before MainActivity has
            // loaded the library.
            System.loadLibrary("funkot_player_lib")
        }

        @JvmStatic
        fun startFrom(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(
                context,
                Intent(context, PlaybackService::class.java),
            )
        }

        @JvmStatic
        fun stopFrom(context: Context) {
            context.stopService(Intent(context, PlaybackService::class.java))
        }

        /** Re-read the paused flag after the app's own buttons changed it. */
        @JvmStatic
        fun syncFrom(context: Context) {
            androidx.core.content.ContextCompat.startForegroundService(
                context,
                Intent(context, PlaybackService::class.java).setAction(ACTION_SYNC),
            )
        }

        /**
         * Packed control state after applying the action:
         * bit0 = paused; bits 1.. = phase discriminant (must match Rust).
         */
        @JvmStatic
        external fun onNativeControl(action: Int): Int

        /** Whether the last notification ⚑ persisted successfully. */
        @JvmStatic
        external fun lastFlagOk(): Boolean

        /** Resolved track title for the notification / MediaSession. */
        @JvmStatic
        external fun currentTitle(): String

        /** Resolved track artist for MediaSession (empty when absent). */
        @JvmStatic
        external fun currentArtist(): String
    }

    private lateinit var session: MediaSession

    /**
     * Transient feedback after tapping ⚑; cleared after [FLAG_FEEDBACK_MS].
     * Android 13+ media UI ignores [Notification.Builder.setSubText], so we
     * also flash it via MediaMetadata artist + a Toast.
     */
    private var flagFeedback: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var clearFlagFeedback: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        session = MediaSession(this, "funkot-player").apply {
            setCallback(object : MediaSession.Callback() {
                // The media UI shows play or pause depending on the state we
                // publish, so both callbacks mean the same thing here: toggle.
                override fun onPlay() = applyControlState(onNativeControl(CONTROL_TOGGLE))
                override fun onPause() = applyControlState(onNativeControl(CONTROL_TOGGLE))
                override fun onSkipToNext() {
                    onNativeControl(CONTROL_NEXT)
                }
                // Android 13+ media controls read PlaybackState custom actions,
                // not Notification.Action. ACTION_FLAG is that custom action.
                override fun onCustomAction(action: String, extras: Bundle?) {
                    if (action != ACTION_FLAG) return
                    onNativeControl(CONTROL_FLAG)
                    showFlagFeedback(lastFlagOk())
                }
            })
            setMetadata(
                MediaMetadata.Builder()
                    .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle())
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist())
                    .build(),
            )
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val packed = when (intent?.action) {
            ACTION_TOGGLE -> onNativeControl(CONTROL_TOGGLE)
            ACTION_NEXT -> onNativeControl(CONTROL_NEXT)
            ACTION_FLAG -> onNativeControl(CONTROL_FLAG).also {
                showFlagFeedback(lastFlagOk())
            }
            // Also covers the first start (null action): query, never assume.
            else -> onNativeControl(CONTROL_QUERY)
        }
        val paused = (packed and 1) != 0
        val phase = packed ushr 1
        val title = currentTitle()
        val artist = currentArtist()

        ensureChannel()
        setPlaybackState(paused, phase)
        setSessionMetadata(title, artist)
        val notification = buildNotification(paused, phase, title)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } else {
            // The service-type overload of startForeground is API 29+; below
            // that, foregroundServiceType in the manifest is just metadata.
            startForeground(NOTIFICATION_ID, notification)
        }

        // Not sticky: playback state lives in the Rust process, so a service
        // the OS recreates on its own after a kill would post transport
        // controls with nothing behind them. Better to let the session end with
        // the process.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        clearFlagFeedback?.let { mainHandler.removeCallbacks(it) }
        clearFlagFeedback = null
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    /** Re-publish state and notification after a control came from the session. */
    private fun applyControlState(packed: Int) {
        val paused = (packed and 1) != 0
        val phase = packed ushr 1
        val title = currentTitle()
        val artist = currentArtist()
        setPlaybackState(paused, phase)
        setSessionMetadata(title, artist)
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(paused, phase, title))
    }

    private fun showFlagFeedback(ok: Boolean) {
        val msg = if (ok) "記録しました" else "記録できませんでした"
        flagFeedback = msg
        Log.i("funkot", "flag feedback: $msg")
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

        clearFlagFeedback?.let { mainHandler.removeCallbacks(it) }
        // Publish now; callers may also refresh — setSessionMetadata keeps
        // flagFeedback on the artist line until the timer clears it.
        val packed = onNativeControl(CONTROL_QUERY)
        applyControlState(packed)

        val clear = Runnable {
            flagFeedback = null
            clearFlagFeedback = null
            applyControlState(onNativeControl(CONTROL_QUERY))
        }
        clearFlagFeedback = clear
        mainHandler.postDelayed(clear, FLAG_FEEDBACK_MS)
    }

    private fun setSessionMetadata(title: String, artist: String) {
        // Android 13+ media UI ignores Notification.setSubText; while feedback
        // is active, surface it on the artist line the controls already show.
        val displayArtist = flagFeedback ?: artist
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, displayArtist)
                .build(),
        )
    }

    private fun setPlaybackState(paused: Boolean, phase: Int) {
        val state = when {
            phase == PHASE_DISCONNECTED -> PlaybackState.STATE_BUFFERING
            paused -> PlaybackState.STATE_PAUSED
            else -> PlaybackState.STATE_PLAYING
        }
        // Android 13+ derives media-control buttons from PlaybackState, not
        // from Notification.Action. With PLAY_PAUSE + SKIP_TO_NEXT and no
        // SKIP_TO_PREVIOUS, the custom ⚑ fills compact slot 2 (pause | ⚑ | next).
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT,
                )
                .addCustomAction(
                    PlaybackState.CustomAction.Builder(
                        ACTION_FLAG,
                        "⚑",
                        R.drawable.ic_flag,
                    ).build(),
                )
                .setState(
                    state,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                    1.0f,
                )
                .build(),
        )
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Playback",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
    }

    private fun selfIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this,
            requestCode,
            Intent(this, PlaybackService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE,
        )

    private fun buildNotification(paused: Boolean, phase: Int, title: String): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )

        // Own drawables rather than android.R.drawable.*: a framework resource
        // id handed out under this app's package name is a mismatch the system
        // UI has to resolve, and it is not worth the risk for three tiny paths.
        // Pre-Android 13 still paints these Notification.Actions; 13+ uses the
        // PlaybackState custom action instead (see setPlaybackState).
        val toggle = Notification.Action.Builder(
            Icon.createWithResource(this, if (paused) R.drawable.ic_play else R.drawable.ic_pause),
            if (paused) "再生" else "一時停止",
            selfIntent(ACTION_TOGGLE, 0),
        ).build()
        val next = Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_next),
            "次へ",
            selfIntent(ACTION_NEXT, 1),
        ).build()
        val flag = Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_flag),
            "⚑",
            selfIntent(ACTION_FLAG, 2),
        ).build()

        val contentText = when {
            phase == PHASE_DISCONNECTED -> "出力切断中"
            paused -> "一時停止中"
            else -> "再生中"
        }

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_play)
            .setContentTitle(title)
            .setContentText(contentText)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .addAction(toggle)
            .addAction(next)
            .addAction(flag)
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2),
            )
        flagFeedback?.let { builder.setSubText(it) }
        return builder.build()
    }
}
