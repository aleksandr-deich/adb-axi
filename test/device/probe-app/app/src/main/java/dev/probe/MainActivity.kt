package dev.probe

import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
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
 *   am start -n dev.probe/.MainActivity --es probe armcrash|finishremove|crashchain|log|file|sql
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
        // Armed by `armcrash`: the next create dies, so a start or a restore sees the process go.
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean(ARMED, false)) {
            prefs.edit().remove(ARMED).commit()
            throw IllegalStateException("probe armed crash on create")
        }
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
            "crashchain" -> throw RuntimeException(
                "probe outer failure",
                IllegalArgumentException(
                    "probe middle failure",
                    IllegalStateException("probe root cause " + "r".repeat(intent.getIntExtra("length", 600))),
                ),
            )
            "armcrash" -> {
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ARMED, true).commit()
                Log.i(TAG, "event=armcrash pid=${Process.myPid()}")
            }
            // Leaves the process alive with no activity and no task in recents.
            "finishremove" -> {
                Log.i(TAG, "event=finishremove pid=${Process.myPid()}")
                finishAndRemoveTask()
            }
            "log" -> logBurst(intent)
            "file" -> writeFile(intent)
            "sql" -> runSql(intent)
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

    /**
     * `--ei count N --es text T [--es level v|d|i|w|e] [--es tag ProbeLog] [--ez numbered true]`:
     * N lines of T, each suffixed ` #i` when numbered, then one `event=log` oracle line.
     */
    private fun logBurst(intent: Intent) {
        val count = intent.getIntExtra("count", 1)
        val text = intent.getStringExtra("text") ?: "probe line"
        val tag = intent.getStringExtra("tag") ?: "ProbeLog"
        val numbered = intent.getBooleanExtra("numbered", false)
        val priority = when (intent.getStringExtra("level")) {
            "v" -> Log.VERBOSE
            "d" -> Log.DEBUG
            "w" -> Log.WARN
            "e" -> Log.ERROR
            else -> Log.INFO
        }
        for (i in 1..count) Log.println(priority, tag, if (numbered) "$text #$i" else text)
        Log.i(TAG, "event=log count=$count pid=${Process.myPid()}")
    }

    /**
     * `--es name N [--es where files|databases] (--es text T | --ei bytes B)`: writes one
     * private file, then logs `event=file`.
     */
    private fun writeFile(intent: Intent) {
        val name = intent.getStringExtra("name") ?: "probe.bin"
        val file = if (intent.getStringExtra("where") == "databases") getDatabasePath(name) else filesDir.resolve(name)
        file.parentFile?.mkdirs()
        val text = intent.getStringExtra("text")
        if (text != null) file.writeText(text) else file.writeBytes(ByteArray(intent.getIntExtra("bytes", 0)) { 0x5a })
        Log.i(TAG, "event=file name=$name bytes=${file.length()} pid=${Process.myPid()}")
    }

    /**
     * `--es db NAME --es stmt SQL [--ez wal true]`: runs one statement on an app database kept
     * open for the life of the process, so a WAL database keeps its -wal and -shm files.
     */
    private fun runSql(intent: Intent) {
        val name = intent.getStringExtra("db") ?: "extra.db"
        val stmt = intent.getStringExtra("stmt") ?: ""
        try {
            val db = databases.getOrPut(name) {
                getDatabasePath(name).parentFile?.mkdirs()
                SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), null).also {
                    if (intent.getBooleanExtra("wal", false)) it.enableWriteAheadLogging()
                }
            }
            db.execSQL(stmt)
            Log.i(TAG, "event=sql db=$name ok pid=${Process.myPid()}")
        } catch (error: Exception) {
            Log.w(TAG, "event=sql db=$name error=${error.message} pid=${Process.myPid()}")
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
        val databases = mutableMapOf<String, SQLiteDatabase>()
        const val PREFS = "probe"
        const val ARMED = "crash_next_create"
        const val TAG = "ProbeState"
        const val EXTRA_PROBE = "probe"
        const val SIGSEGV = 11
        const val ANR_BLOCK_MS = 30_000L
    }
}
