package dev.probe

import android.content.Intent
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.channels.Channel

/**
 * A probe for adb-axi's real-device checks, driven only by explicit intents:
 *
 *   am start -n dev.probe/.MainActivity --es probe inc|state|write|finish|crash|native|anr
 *
 * Every state change logs one `ProbeState` line, the oracle the checks read from logcat:
 *
 *   ProbeState event=inc saved=3 volatile=3 rows=0 restored=false pid=4321
 *
 * `saved` survives process death (rememberSaveable); `volatile` does not (remember).
 */
class MainActivity : ComponentActivity() {
    private val actions = Channel<String>(Channel.UNLIMITED)
    private var restored = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        restored = savedInstanceState != null
        // A recreated activity gets its original intent back; only a fresh start acts on it.
        if (!restored) dispatch(intent)
        setContent { ProbeScreen() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        dispatch(intent)
    }

    private fun dispatch(intent: Intent) {
        when (val action = intent.getStringExtra(EXTRA_PROBE)) {
            null -> Unit
            // Leaves the process alive with no activity, so the next start is a warm one.
            "finish" -> {
                Log.i(TAG, "event=finish pid=${Process.myPid()}")
                finish()
            }
            "crash" -> throw IllegalStateException("probe crash requested")
            // SIGSEGV to itself: debuggerd writes a native crash tombstone without any NDK code.
            "native" -> Process.sendSignal(Process.myPid(), SIGSEGV)
            // Blocks the main thread; any input sent meanwhile times out into an ANR.
            "anr" -> {
                Log.i(TAG, "event=anr blocking main thread for ${ANR_BLOCK_MS}ms pid=${Process.myPid()}")
                SystemClock.sleep(ANR_BLOCK_MS)
            }
            "inc", "state", "write" -> actions.trySend(action)
            else -> Log.w(TAG, "event=unknown action=$action pid=${Process.myPid()}")
        }
    }

    @Composable
    private fun ProbeScreen() {
        var saved by rememberSaveable { mutableIntStateOf(0) }
        var volatile by remember { mutableIntStateOf(0) }
        val db = remember { ProbeDatabase.get(applicationContext) }
        var rows by remember { mutableIntStateOf(db.notes().count()) }

        LaunchedEffect(Unit) {
            fun log(event: String) = Log.i(
                TAG,
                "event=$event saved=$saved volatile=$volatile rows=$rows restored=$restored pid=${Process.myPid()}",
            )
            log("start")
            for (action in actions) {
                when (action) {
                    "inc" -> {
                        saved++
                        volatile++
                    }
                    "write" -> {
                        db.notes().insert(Note(text = "probe-${rows + 1}", createdAt = System.currentTimeMillis()))
                        rows = db.notes().count()
                    }
                }
                log(action)
            }
        }

        val style = TextStyle(fontSize = 20.sp)
        Column(
            modifier = Modifier.fillMaxSize().background(Color.White).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            BasicText("dev.probe", style = TextStyle(fontSize = 28.sp))
            BasicText("saved: $saved", style = style)
            BasicText("volatile: $volatile", style = style)
            BasicText("rows: $rows", style = style)
            BasicText("restored: $restored", style = style)
        }
    }

    private companion object {
        const val TAG = "ProbeState"
        const val EXTRA_PROBE = "probe"
        const val SIGSEGV = 11
        const val ANR_BLOCK_MS = 30_000L
    }
}
