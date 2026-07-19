package com.sidhu.device.runtime.android.shizuku

import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode

data class RuntimeReadiness(
    val ready: Boolean,
    val detail: String = "",
    val failureCode: AndroidScreenCaptureFailureCode? = null,
)

fun interface RuntimeReadinessGate {
    suspend fun awaitReady(timeoutMs: Long): RuntimeReadiness
}
