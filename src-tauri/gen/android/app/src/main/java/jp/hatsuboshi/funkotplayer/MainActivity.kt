package jp.hatsuboshi.funkotplayer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // TauriActivity sets handleBackNavigation=false, so the platform default
    // finishes this activity. tao then sees the last window destroyed and
    // calls process::exit, which kills the playback FGS along with the UI.
    // Background the task instead: the process, cpal stream, and
    // PlaybackService stay up. Recents swipe still finishes the activity;
    // Rust prevent_exit covers that path while the service is up.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          moveTaskToBack(true)
        }
      },
    )

    // Needed to show the playback notification on Android 13+; without it
    // background playback (via PlaybackService) still works, the notification
    // just never appears.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }

    // Cold-start share-sheet import (ACTION_SEND / ACTION_SEND_MULTIPLE, see
    // AndroidManifest.xml). The already-running path is onNewIntent below.
    //
    // Only on a genuinely fresh start (savedInstanceState == null): onCreate
    // also re-runs on a configuration change this Activity does not declare
    // in android:configChanges (e.g. fontScale/density -- a system font size
    // change) or on task/process restoration, and each of those replays the
    // same ACTION_SEND intent that launched it. Without this guard, that
    // would stage (and import) the same shared file a second time as
    // "song (2).mp3".
    if (savedInstanceState == null) {
      Import.onIntent(this, intent)
    }
  }

  override fun onResume() {
    super.onResume()
    // Android takes the playback service away behind our back once it has been
    // paused for a while (see PlaybackService). Coming back to the screen is
    // both when we can notice and when starting one is allowed again.
    PlaybackService.reassertIfPlaying(this)
  }

  override fun onNewIntent(intent: Intent) {
    // Must run first: TauriActivity.onNewIntent (generated/TauriActivity.kt)
    // routes to PluginManager.onNewIntent / Rust.onNewIntent, and skipping it
    // would break Tauri.
    super.onNewIntent(intent)
    Import.onIntent(this, intent)
  }
}
