package com.sidhu.device.uiautomationhelper

import android.app.Instrumentation
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Bundle
import android.util.Log

class UiAutomationHelperInstrumentation : Instrumentation() {
    private lateinit var startArguments: Bundle

    override fun onCreate(arguments: Bundle) {
        startArguments = Bundle(arguments)
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val port = startArguments.getString("port")?.toIntOrNull()
        val token = startArguments.getString("token").orEmpty()
        if (port == null || token.length < MIN_TOKEN_LENGTH) {
            finishWith("invalid_arguments")
            return
        }

        val automation = runCatching { connectedUiAutomation() }.getOrElse {
            Log.e(TAG, "uiautomation_connect_failed", it)
            finishWith("uiautomation_connect_failed")
            return
        }
        val server = runCatching { LoopbackSnapshotServer(automation, port, token) }.getOrElse {
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

    private fun connectedUiAutomation() = uiAutomation.also { automation ->
        repeat(40) {
            runCatching { automation.serviceInfo }.getOrNull()?.let { serviceInfo ->
                if (serviceInfo.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0) {
                    serviceInfo.flags = serviceInfo.flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                    automation.serviceInfo = serviceInfo
                }
                return automation
            }
            Thread.sleep(50)
        }
        error("UiAutomation connection timed out")
    }

    private companion object {
        const val TAG = "HuahuaUiAutomation"
        const val PROTOCOL_VERSION = 1
        const val MIN_TOKEN_LENGTH = 32
    }
}
