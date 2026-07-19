package com.sidhu.device.agent

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.sidhu.device.runtime.android.DeviceLeaseCoordinator

/**
 * Minimal runtime integration sample for contributors. Production pairing,
 * LAN transport, permissions, and execution UI belong to the HuAHua app.
 */
class MainActivity : AppCompatActivity() {
    private val leases = DeviceLeaseCoordinator()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(
            TextView(this).apply {
                setPadding(48, 96, 48, 48)
                text = buildString {
                    append(getString(R.string.agent_status_ready))
                    append("\\n\\n")
                    append(getString(R.string.agent_status_no_host))
                    append("\\n")
                    append(getString(R.string.agent_status_lease, leases.currentHolder() ?: getString(R.string.agent_lease_available)))
                }
                textSize = 20f
            },
        )
    }
}
