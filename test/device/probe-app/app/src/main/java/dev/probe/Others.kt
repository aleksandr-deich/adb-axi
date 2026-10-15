package dev.probe

import android.Manifest
import android.content.Intent
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.util.Log
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Runs in the `:ui` process, so the probe has a second process of its own. */
class UiActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "dev.probe:ui" })
        Log.i("ProbeState", "event=ui pid=${Process.myPid()}")
    }
}

/** Opens system Settings over itself, so the probe starts but another app is in front. */
class BounceActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i("ProbeState", "event=bounce pid=${Process.myPid()}")
        if (savedInstanceState == null) startActivity(Intent(Settings.ACTION_SETTINGS))
    }
}

/** Asks for a runtime permission at once, so the permission controller's dialog is on top. */
class PermActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i("ProbeState", "event=perm pid=${Process.myPid()}")
        if (savedInstanceState == null) requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
    }
}

/** Not exported: `am start` from the shell is refused with a security exception. */
class PrivateActivity : ComponentActivity()

/** A nested activity class, `dev.probe.Outer$Inner`, whose name a device shell would expand. */
class Outer {
    class Inner : ComponentActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            setContentView(TextView(this).apply { text = "dev.probe.Outer\$Inner" })
            Log.i("ProbeState", "event=inner pid=${Process.myPid()}")
        }
    }
}
