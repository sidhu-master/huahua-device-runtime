package com.sidhu.device.runtime.android

interface AndroidDeviceRuntime : DeviceRuntime {
    suspend fun prepareScreenshot(
        timeoutMs: Long = 1_500L,
    ): AndroidScreenCapturePreparation

    suspend fun capturePreparedScreenshot(
        preparation: AndroidScreenCapturePreparation.Ready,
        timeoutMs: Long = 5_000L,
    ): AndroidScreenCaptureResult

    /** Convenience form with one shared timeout budget across preparation and capture. */
    suspend fun captureScreenshot(timeoutMs: Long = 5_000L): AndroidScreenCaptureResult
}

sealed interface AndroidScreenCapturePreparation {
    data object Ready : AndroidScreenCapturePreparation

    data class Failed(
        val code: AndroidScreenCaptureFailureCode,
        val detail: String,
    ) : AndroidScreenCapturePreparation
}

enum class AndroidScreenCaptureFailureCode {
    UNAVAILABLE,
    NOT_READY,
    BINDER_UNAVAILABLE,
    PROCESS_SETUP_FAILED,
    EXECUTION_FAILED,
    TIMEOUT,
}

sealed interface AndroidScreenCaptureResult {
    data class Captured(
        val pngBytes: ByteArray,
        val elapsedMs: Long,
        val detail: String = "",
    ) : AndroidScreenCaptureResult

    data class Failed(
        val code: AndroidScreenCaptureFailureCode,
        val detail: String,
    ) : AndroidScreenCaptureResult
}
