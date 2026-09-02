package jp.hatsuboshi.funkotplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
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
import java.util.Locale

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
 * Foreground only while sound is actually coming out. Android reaps a
 * `mediaPlayback` service that sits in the foreground while paused: after
 * about ten minutes it demotes the service, destroys it a minute later, then
 * freezes and reclaims the process — silence, with no notification left to
 * come back through. So pausing drops the foreground state on our own terms
 * and detaches the notification, which then survives the service and is the
 * way back: its transport actions start the service again (see
 * [publishState], [onDestroy], and `playbackAlive` on the Rust side).
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

        /**
         * Set by [stopFrom] so [onDestroy] can tell the app taking the service
         * down from Android taking it down under us; only the latter leaves a
         * notification behind.
         */
        @Volatile
        private var deliberateStop = false

        @JvmStatic
        fun startFrom(context: Context) = startService(context, null)

        @JvmStatic
        fun stopFrom(context: Context) {
            deliberateStop = true
            context.stopService(Intent(context, PlaybackService::class.java))
        }

        /** Re-read the paused flag after the app's own buttons changed it. */
        @JvmStatic
        fun syncFrom(context: Context) = startService(context, ACTION_SYNC)

        /**
         * Put the foreground service back after Android took it away.
         *
         * Nothing tells the app that its service was demoted and reaped, and
         * the app is not allowed to start one from the background anyway. The
         * listener returning to the app is both when we can notice and when
         * the start is permitted again, so [MainActivity] calls this from
         * onResume. Idempotent: a service that is already up just re-publishes
         * its notification. Paused is left alone on purpose — being out of the
         * foreground is the point while nothing is playing.
         */
        @JvmStatic
        fun reassertIfPlaying(context: Context) {
            if (!playbackAlive()) return
            if ((onNativeControl(CONTROL_QUERY) and 1) != 0) return
            startFrom(context)
        }

        private fun startService(context: Context, action: String?) {
            val intent = Intent(context, PlaybackService::class.java)
            if (action != null) intent.action = action
            try {
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // Android 12+ refuses a foreground-service start made from the
                // background (ForegroundServiceStartNotAllowedException), and
                // this is reached from the events thread as tracks change.
                // Audio does not depend on it; the notification just goes
                // stale until the next start that is allowed. Never let it
                // reach the JNI caller as a pending Java exception.
                Log.w("funkot", "startForegroundService($action): $e")
            }
        }

        /**
         * Packed control state after applying the action:
         * bit0 = paused; bits 1.. = phase discriminant (must match Rust).
         */
        @JvmStatic
        external fun onNativeControl(action: Int): Int

        /**
         * Whether a playback session still stands behind the notification.
         * False in a process the notification outlived (see the Rust
         * `playback_session_alive`).
         */
        @JvmStatic
        external fun playbackAlive(): Boolean

        /** Whether the last notification ⚑ persisted successfully. */
        @JvmStatic
        external fun lastFlagOk(): Boolean

        /** Resolved track title for the notification / MediaSession. */
        @JvmStatic
        external fun currentTitle(): String

        /** Resolved track artist for MediaSession (empty when absent). */
        @JvmStatic
        external fun currentArtist(): String

        /** Stored UI locale, or empty to follow the device locale. */
        @JvmStatic
        external fun currentLocaleTag(): String
    }

    private lateinit var session: MediaSession

    /**
     * Transient feedback after tapping ⚑; cleared after [FLAG_FEEDBACK_MS].
     * Android 13+ media UI ignores [Notification.Builder.setSubText], so we
     * also flash it via MediaMetadata artist + a Toast.
     */
    private var flagFeedback: String? = null

    /** Whether [startForeground] currently holds, so we detach exactly once. */
    private var isForeground = false

    private val mainHandler = Handler(Looper.getMainLooper())
    private var clearFlagFeedback: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    private fun localizedContext(): Context {
        val tag = currentLocaleTag()
        if (tag.isBlank()) return this
        val config = Configuration(resources.configuration)
        config.setLocale(Locale.forLanguageTag(tag))
        return createConfigurationContext(config)
    }

    private fun text(resourceId: Int): String = localizedContext().getString(resourceId)

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
        // The paused notification outlives this service and can outlive the
        // process; Android keeps it posted for the package either way. A
        // transport tap landing in a process with nothing playing has nothing
        // to control, so retire the leftover rather than show dead controls.
        if (!playbackAlive()) {
            retireStaleNotification()
            return START_NOT_STICKY
        }

        val packed = when (intent?.action) {
            ACTION_TOGGLE -> onNativeControl(CONTROL_TOGGLE)
            ACTION_NEXT -> onNativeControl(CONTROL_NEXT)
            ACTION_FLAG -> onNativeControl(CONTROL_FLAG).also {
                showFlagFeedback(lastFlagOk())
            }
            // Also covers the first start (null action): query, never assume.
            else -> onNativeControl(CONTROL_QUERY)
        }
        publishState(packed, fromStart = true)

        // Not sticky: playback state lives in the Rust process, so a service
        // the OS recreates on its own after a kill would post transport
        // controls with nothing behind them. Better to let the session end with
        // the process.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        clearFlagFeedback?.let { mainHandler.removeCallbacks(it) }
        clearFlagFeedback = null
        // Android destroys this service a minute or so after it stops being
        // foreground, which for us means "the listener paused a while ago".
        // The notification is their way back, so re-post it as its own
        // notification first: it is currently a MediaStyle backed by the
        // session about to be released, which would leave the shade drawing
        // media controls for a session that no longer exists. A stop we asked
        // for, or a session that is gone, means nobody is coming back.
        if (!deliberateStop && !isForeground && playbackAlive()) {
            val packed = onNativeControl(CONTROL_QUERY)
            getSystemService(NotificationManager::class.java).notify(
                NOTIFICATION_ID,
                buildNotification((packed and 1) != 0, packed ushr 1, currentTitle(), false),
            )
        } else {
            leaveForeground(remove = true)
        }
        deliberateStop = false
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    /** Re-publish state and notification after a control came from the session. */
    private fun applyControlState(packed: Int) = publishState(packed)

    /**
     * Publish one control state everywhere it shows: the MediaSession, the
     * notification, and whether we are a foreground service at all.
     *
     * @param fromStart this came from [onStartCommand], so the system is
     *   waiting on a startForeground call for it.
     */
    private fun publishState(packed: Int, fromStart: Boolean = false) {
        val paused = (packed and 1) != 0
        val phase = packed ushr 1
        val title = currentTitle()

        ensureChannel()
        setPlaybackState(paused, phase)
        setSessionMetadata(title, currentArtist())
        val notification = buildNotification(paused, phase, title)

        if (!paused) {
            enterForeground(notification)
            return
        }

        // Paused: no foreground service (see the class comment). A start that
        // came through startForegroundService still owes the system one
        // startForeground within five seconds whatever the outcome — omitting
        // it is itself a crash (ForegroundServiceDidNotStartInTimeException) —
        // so take the foreground and hand it straight back, keeping the
        // notification. Anything else just updates the notification in place.
        if (fromStart) {
            enterForeground(notification)
        } else {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, notification)
        }
        leaveForeground(remove = false)
    }

    private fun enterForeground(notification: Notification) {
        try {
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
            isForeground = true
        } catch (e: Exception) {
            // Android 12+ can refuse a foreground start made from the
            // background. Post the notification anyway — it is the listener's
            // way back — and let the next allowed start re-assert the service.
            Log.w("funkot", "startForeground: $e")
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, notification)
        }
    }

    /** Leave the foreground, keeping (`remove = false`) the notification. */
    private fun leaveForeground(remove: Boolean) {
        if (isForeground) {
            stopForeground(if (remove) STOP_FOREGROUND_REMOVE else STOP_FOREGROUND_DETACH)
            isForeground = false
        } else if (remove) {
            getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
        }
    }

    /**
     * Take down a notification whose playback session is gone and stop.
     *
     * Still goes foreground first: this start came from a `PendingIntent` the
     * stale notification owns, so the five-second startForeground contract
     * applies here too.
     */
    private fun retireStaleNotification() {
        ensureChannel()
        enterForeground(buildNotification(true, 0, currentTitle(), false))
        leaveForeground(remove = true)
        stopSelf()
    }

    private fun showFlagFeedback(ok: Boolean) {
        val msg = text(if (ok) R.string.notification_flag_saved else R.string.notification_flag_failed)
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
        // Re-creating an existing channel updates its user-visible name, so a
        // language switch also updates Android Settings without changing the
        // channel's stable identity or importance.
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                text(R.string.notification_channel_playback),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    /**
     * getForegroundService, not getService: while paused we are not a
     * foreground service (and may not be running at all), so a plain
     * background start of ⏵ would be refused. Starting as a foreground
     * service is what the tap is allowed to do — [onStartCommand] holds up
     * its end by calling startForeground on every path.
     */
    private fun selfIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getForegroundService(
            this,
            requestCode,
            Intent(this, PlaybackService::class.java).setAction(action),
            PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * @param withSession false once the MediaSession is going away (see
     *   [onDestroy]) or was never behind this notification, so the shade draws
     *   the notification's own actions instead of controls for a dead session.
     */
    private fun buildNotification(
        paused: Boolean,
        phase: Int,
        title: String,
        withSession: Boolean = true,
    ): Notification {
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
            text(if (paused) R.string.notification_play else R.string.notification_pause),
            selfIntent(ACTION_TOGGLE, 0),
        ).build()
        val next = Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_next),
            text(R.string.notification_next),
            selfIntent(ACTION_NEXT, 1),
        ).build()
        val flag = Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_flag),
            "⚑",
            selfIntent(ACTION_FLAG, 2),
        ).build()

        val contentText = when {
            phase == PHASE_DISCONNECTED -> text(R.string.notification_output_disconnected)
            paused -> text(R.string.notification_paused)
            else -> text(R.string.notification_playing)
        }

        val style = Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2)
        if (withSession) {
            style.setMediaSession(session.sessionToken)
        }

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_play)
            .setContentTitle(title)
            .setContentText(contentText)
            // Ongoing only while playing. Paused, this notification is no
            // longer tied to a foreground service and may outlive the process,
            // so the listener has to be able to swipe it away.
            .setOngoing(!paused)
            .setContentIntent(contentIntent)
            .addAction(toggle)
            .addAction(next)
            .addAction(flag)
            .setStyle(style)
        flagFeedback?.let { builder.setSubText(it) }
        return builder.build()
    }
}
