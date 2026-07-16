package com.sidhu.device.runtime.android.shizuku

import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ShizukuAndroidDeviceRuntimeTest {
    @Test
    fun retriesOnceAfterRetryableBinderFailure() = runTest {
        val fakeShell = FakeShellExecutor(
            responses = mutableListOf(
                RuntimeShellResult(false, "Shizuku binder not ready"),
                RuntimeShellResult(true, ""),
            ),
        )
        val shell = RetryingShellExecutor(
            readinessGate = RuntimeReadinessGate { RuntimeReadiness(ready = true) },
            delegate = fakeShell,
        )

        val result = shell.executeWithRetry("input keyevent 3", timeoutMs = 5_000L)

        assertTrue(result.success)
        assertEquals(2, fakeShell.commands.size)
    }

    @Test
    fun actionStopsBeforeShellWhenInitialReadinessCannotRecover() = runTest {
        var requestedTimeoutMs = 0L
        val fakeShell = FakeShellExecutor(
            responses = mutableListOf(RuntimeShellResult(true, "")),
        )
        val shell = RetryingShellExecutor(
            readinessGate = RuntimeReadinessGate { timeoutMs ->
                requestedTimeoutMs = timeoutMs
                RuntimeReadiness(
                    ready = false,
                    detail = "not ready",
                    failureCode = AndroidScreenCaptureFailureCode.NOT_READY,
                )
            },
            delegate = fakeShell,
        )

        val result = shell.executeWithRetry("input keyevent 3", timeoutMs = 5_000L)

        assertTrue(!result.success)
        assertEquals(AndroidScreenCaptureFailureCode.NOT_READY, result.failureCode)
        assertEquals(1_800L, requestedTimeoutMs)
        assertTrue(fakeShell.commands.isEmpty())
    }
}

private class FakeShellExecutor(
    val responses: MutableList<RuntimeShellResult> = mutableListOf(),
    val binaryResponses: MutableList<RuntimeBinaryResult> = mutableListOf(),
) : RestrictedShellExecutor {
    var preparationResult = RuntimeShellResult(true, "")
    var prepareCalls = 0
    var afterPreparation: (() -> Unit)? = null
    var afterBinaryExecution: (() -> Unit)? = null
    val commands = mutableListOf<String>()
    val binaryCommands = mutableListOf<List<String>>()
    val binaryTimeouts = mutableListOf<Long>()

    override suspend fun prepare(timeoutMs: Long): RuntimeShellResult {
        prepareCalls += 1
        afterPreparation?.invoke()
        return preparationResult
    }

    override suspend fun execute(command: String, timeoutMs: Long): RuntimeShellResult {
        commands += command
        return if (responses.isNotEmpty()) responses.removeAt(0) else RuntimeShellResult(false, "no fake response")
    }

    override suspend fun executeBinary(command: List<String>, timeoutMs: Long): RuntimeBinaryResult {
        binaryCommands += command
        binaryTimeouts += timeoutMs
        afterBinaryExecution?.invoke()
        return if (binaryResponses.isNotEmpty()) {
            binaryResponses.removeAt(0)
        } else {
            RuntimeBinaryResult(false, stderr = "no fake binary response")
        }
    }
}
