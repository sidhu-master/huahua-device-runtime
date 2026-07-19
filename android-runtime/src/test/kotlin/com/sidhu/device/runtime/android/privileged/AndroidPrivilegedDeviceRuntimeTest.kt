package com.sidhu.device.runtime.android.privileged

import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode
import com.sidhu.device.runtime.android.AndroidScreenCapturePreparation
import com.sidhu.device.runtime.android.AndroidScreenCaptureResult
import com.sidhu.device.contracts.DeviceCommand
import com.sidhu.device.contracts.DeviceReceipt
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPrivilegedDeviceRuntimeTest {
    @Test
    fun retriesOnceAfterRetryableBinderFailure() = runTest {
        val fakeShell = FakeShellExecutor(
            responses = mutableListOf(
                RuntimeShellResult(false, "privileged bridge not ready"),
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

    @Test
    fun tapFallsBackToShortSwipeWhenPrimaryTapFails() = runTest {
        val shell = FakeShellExecutor(
            responses = mutableListOf(
                RuntimeShellResult(false, "input failed"),
                RuntimeShellResult(true, ""),
            ),
        )

        val receipt = runtimeFor(shell).execute(DeviceCommand.Tap(12, 24))

        assertEquals(DeviceReceipt.Outcome.SUCCEEDED, receipt.outcome)
        assertEquals(listOf("input tap 12 24", "input swipe 12 24 12 24 120"), shell.commands)
    }

    @Test
    fun tapDoesNotFallbackWhenInputInjectionIsDenied() = runTest {
        val shell = FakeShellExecutor(
            responses = mutableListOf(
                RuntimeShellResult(false, "injecting input events requires INJECT_EVENTS"),
            ),
        )

        val receipt = runtimeFor(shell).execute(DeviceCommand.Tap(12, 24))

        assertEquals(DeviceReceipt.Outcome.FAILED, receipt.outcome)
        assertEquals(listOf("input tap 12 24"), shell.commands)
        assertEquals("true", receipt.transientFacts["input_injection_permission_denied"])
    }

    @Test
    fun swipeClampsDurationToAndroidSafeRange() = runTest {
        val shell = FakeShellExecutor(responses = mutableListOf(RuntimeShellResult(true, "")))

        val receipt = runtimeFor(shell).execute(DeviceCommand.Swipe(1, 2, 3, 4, durationMs = 9_000L))

        assertEquals(DeviceReceipt.Outcome.SUCCEEDED, receipt.outcome)
        assertEquals("input swipe 1 2 3 4 3000", shell.commands.single())
    }

    @Test
    fun launchRejectsUnsafePackageNameWithoutOpeningShell() = runTest {
        val shell = FakeShellExecutor()

        val receipt = runtimeFor(shell).execute(DeviceCommand.LaunchApp("com.example; rm -rf /"))

        assertEquals(DeviceReceipt.Outcome.FAILED, receipt.outcome)
        assertTrue(shell.commands.isEmpty())
    }

    @Test
    fun screenshotUsesSecondScreencapCommandAfterFirstFailure() = runTest {
        val shell = FakeShellExecutor(
            binaryResponses = mutableListOf(
                RuntimeBinaryResult(false, stderr = "not found"),
                RuntimeBinaryResult(true, stdout = byteArrayOf(1, 2, 3)),
            ),
        )
        val runtime = runtimeFor(shell)
        val preparation = runtime.prepareScreenshot()

        assertEquals(AndroidScreenCapturePreparation.Ready, preparation)
        assertTrue(shell.binaryCommands.isEmpty())

        val result = runtime.capturePreparedScreenshot(
            preparation as AndroidScreenCapturePreparation.Ready,
        )

        assertEquals(byteArrayOf(1, 2, 3).toList(), (result as AndroidScreenCaptureResult.Captured).pngBytes.toList())
        assertEquals(
            listOf(listOf("/system/bin/screencap", "-p"), listOf("screencap", "-p")),
            shell.binaryCommands,
        )
    }

    @Test
    fun screenshotFallbackSharesOneTimeoutBudget() = runTest {
        var now = 0L
        val shell = FakeShellExecutor(
            binaryResponses = mutableListOf(
                RuntimeBinaryResult(false, stderr = "first failed"),
                RuntimeBinaryResult(true, stdout = byteArrayOf(7)),
            ),
        ).also { fake ->
            fake.afterBinaryExecution = { now += 400L }
        }
        val runtime = runtimeFor(shell, nowMs = { now })
        val preparation = runtime.prepareScreenshot()

        runtime.capturePreparedScreenshot(
            preparation as AndroidScreenCapturePreparation.Ready,
            timeoutMs = 1_000L,
        )

        assertEquals(listOf(1_000L, 600L), shell.binaryTimeouts)
    }

    @Test
    fun screenshotDoesNotStartFallbackAfterBudgetIsExhausted() = runTest {
        var now = 0L
        val shell = FakeShellExecutor(
            binaryResponses = mutableListOf(
                RuntimeBinaryResult(false, stderr = "first failed"),
                RuntimeBinaryResult(true, stdout = byteArrayOf(8)),
            ),
        ).also { fake ->
            fake.afterBinaryExecution = { now += 1_000L }
        }
        val runtime = runtimeFor(shell, nowMs = { now })
        val preparation = runtime.prepareScreenshot()

        val result = runtime.capturePreparedScreenshot(
            preparation as AndroidScreenCapturePreparation.Ready,
            timeoutMs = 1_000L,
        )

        assertEquals(
            AndroidScreenCaptureFailureCode.TIMEOUT,
            (result as AndroidScreenCaptureResult.Failed).code,
        )
        assertEquals(listOf(listOf("/system/bin/screencap", "-p")), shell.binaryCommands)
    }

    @Test
    fun oneShotScreenshotSharesItsBudgetWithPreparation() = runTest {
        var now = 0L
        val shell = FakeShellExecutor(
            binaryResponses = mutableListOf(
                RuntimeBinaryResult(true, stdout = byteArrayOf(9)),
            ),
        ).also { fake ->
            fake.afterPreparation = { now += 250L }
        }

        runtimeFor(shell, nowMs = { now }).captureScreenshot(timeoutMs = 1_000L)

        assertEquals(listOf(750L), shell.binaryTimeouts)
    }

    private fun runtimeFor(
        shell: FakeShellExecutor,
        nowMs: () -> Long = { 0L },
    ): AndroidPrivilegedDeviceRuntime = AndroidPrivilegedDeviceRuntime(shell, nowMs)
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
