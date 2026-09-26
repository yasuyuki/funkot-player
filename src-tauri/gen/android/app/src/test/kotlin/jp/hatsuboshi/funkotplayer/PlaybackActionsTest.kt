package jp.hatsuboshi.funkotplayer

import android.media.session.PlaybackState
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackActionsTest {
    @Test
    fun mediaSessionAdvertisesDedicatedAndToggleTransportActions() {
        val actions = MEDIA_SESSION_ACTIONS
        for (action in longArrayOf(
            PlaybackState.ACTION_PLAY_PAUSE,
            PlaybackState.ACTION_PLAY,
            PlaybackState.ACTION_PAUSE,
            PlaybackState.ACTION_SKIP_TO_NEXT,
        )) {
            assertEquals(action, actions and action)
        }
    }
}
