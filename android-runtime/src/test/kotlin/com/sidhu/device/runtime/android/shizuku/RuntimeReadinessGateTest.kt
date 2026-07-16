package com.sidhu.device.runtime.android.shizuku

import com.sidhu.device.runtime.android.AndroidScreenCapturePreparation
import com.sidhu.device.runtime.android.AndroidScreenCaptureResult
import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeReadinessGateTest {
    @Test
    fun failedReadinessKeepsItsStructuredFailureCode() {
        val readiness = RuntimeReadiness(
            ready = false,
            detail = "binder_not_ready",
            failureCode = AndroidScreenCaptureFailureCode.BINDER_UNAVAILABLE,
        )

        assertEquals(AndroidScreenCaptureFailureCode.BINDER_UNAVAILABLE, readiness.failureCode)
    }

    @Test
    fun failedPreparationKeepsReadinessDiagnosticsOutsidePortableReceipt() {
        val preparation: AndroidScreenCapturePreparation =
            AndroidScreenCapturePreparation.Failed(
                AndroidScreenCaptureFailureCode.BINDER_UNAVAILABLE,
                "binder_not_ready",
            )

        assertTrue(preparation is AndroidScreenCapturePreparation.Failed)
        assertEquals(
            "binder_not_ready",
            (preparation as AndroidScreenCapturePreparation.Failed).detail,
        )
    }

    @Test
    fun failedCaptureKeepsDiagnosticsOutsidePortableReceipt() {
        val result: AndroidScreenCaptureResult =
            AndroidScreenCaptureResult.Failed(
                AndroidScreenCaptureFailureCode.BINDER_UNAVAILABLE,
                "binder_not_ready",
            )

        assertTrue(result is AndroidScreenCaptureResult.Failed)
        assertEquals("binder_not_ready", (result as AndroidScreenCaptureResult.Failed).detail)
    }
}
