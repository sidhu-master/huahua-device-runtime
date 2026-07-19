package com.sidhu.device.uiautomationhelper

import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry

class UiAutomationHelperInstrumentation : Instrumentation() {
    override fun onStart() {
        start()
        val arguments = InstrumentationRegistry.getArguments()
        val port = arguments.getString("port")?.toIntOrNull()
        val token = arguments.getString("token").orEmpty()
        if (port == null || token.length < MIN_TOKEN_LENGTH) {
            finishWith("invalid_arguments")
            return
        }

        val server = runCatching { LoopbackSnapshotServer(uiAutomation, port, token) }.getOrElse {
            Log.e(TAG, "helper_start_failed", it)
            finishWith("start_failed")
            return
        }
        server.start()
        sendStatus(0, Bundle().apply {
            putString("state", "ready")
            putInt("port", port)
            putInt("protocol_version", PROTOCOL_VERSION)
        })
        runCatching { server.awaitClose() }
            .onFailure { Log.e(TAG, "helper_server_failed", it) }
        server.close()
        finishWith("stopped")
    }

    private fun finishWith(state: String) {
        finish(0, Bundle().apply { putString("state", state) })
    }

    private companion object {
        const val TAG = "HuahuaUiAutomation"
        const val PROTOCOL_VERSION = 1
        const val MIN_TOKEN_LENGTH = 32
    }
}
