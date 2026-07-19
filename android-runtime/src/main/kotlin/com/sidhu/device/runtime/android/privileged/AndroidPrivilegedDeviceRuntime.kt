package com.sidhu.device.runtime.android.privileged

import android.os.SystemClock
import com.sidhu.device.contracts.DeviceCapability
import com.sidhu.device.contracts.DeviceCommand
import com.sidhu.device.contracts.DeviceReceipt
import com.sidhu.device.runtime.android.AndroidDeviceRuntime
import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode
import com.sidhu.device.runtime.android.AndroidScreenCapturePreparation
import com.sidhu.device.runtime.android.AndroidScreenCaptureResult

class AndroidPrivilegedDeviceRuntime private constructor(
    private val shell: RetryingShellExecutor,
    private val nowMs: () -> Long,
) : AndroidDeviceRuntime {
    constructor(
        readinessGate: RuntimeReadinessGate,
        processBridge: PrivilegedProcessBridge,
    ) : this(
        RetryingShellExecutor(readinessGate, PrivilegedShellExecutor(processBridge)),
        { SystemClock.elapsedRealtime() },
    )

    internal constructor(
        shell: RestrictedShellExecutor,
        nowMs: () -> Long = { SystemClock.elapsedRealtime() },
    ) : this(
        RetryingShellExecutor(RuntimeReadinessGate { RuntimeReadiness(ready = true) }, shell),
        nowMs,
    )

    override val capabilities = DeviceCapability(
        supportsScreenshots = true,
        supportsUiTree = false,
        supportsScreenRecording = false,
        supportsPerformanceMetrics = false,
    )

    override suspend fun execute(command: DeviceCommand): DeviceReceipt = when (command) {
        is DeviceCommand.Tap -> executeTap(command)
        is DeviceCommand.Swipe -> executeShell(
            command,
            "input swipe ${command.startX} ${command.startY} ${command.endX} ${command.endY} ${command.durationMs.coerceIn(80L, 3_000L)}",
        )
        is DeviceCommand.LongPress -> executeShell(
            command,
            "input swipe ${command.x} ${command.y} ${command.x} ${command.y} ${command.durationMs.coerceIn(80L, 3_000L)}",
        )
        DeviceCommand.Back -> executeShell(command, "input keyevent 4")
        DeviceCommand.Home -> executeShell(command, "input keyevent 3")
        is DeviceCommand.LaunchApp -> executeLaunch(command)
        is DeviceCommand.InputText -> unsupported(command, "Text input migration is a separate runtime slice")
        DeviceCommand.Observe -> unsupported(command, "Observation mapping is not part of this runtime slice")
    }

    override suspend fun prepareScreenshot(timeoutMs: Long): AndroidScreenCapturePreparation {
        val result = shell.prepareScreenshot(timeoutMs)
        return if (result.success) {
            AndroidScreenCapturePreparation.Ready
        } else {
            AndroidScreenCapturePreparation.Failed(
                result.failureCode ?: AndroidScreenCaptureFailureCode.EXECUTION_FAILED,
                boundedDetail(result.output),
            )
        }
    }

    override suspend fun capturePreparedScreenshot(
        preparation: AndroidScreenCapturePreparation.Ready,
        timeoutMs: Long,
    ): AndroidScreenCaptureResult {
        val startedAt = nowMs()
        val deadline = startedAt + timeoutMs.coerceAtLeast(0L)
        val attempts = listOf(
            "/system/bin/screencap" to listOf("/system/bin/screencap", "-p"),
            "screencap" to listOf("screencap", "-p"),
        )
        val summaries = mutableListOf<String>()
        var lastCode = AndroidScreenCaptureFailureCode.EXECUTION_FAILED

        for ((label, command) in attempts) {
            val remainingMs = deadline - nowMs()
            if (remainingMs <= 0L) {
                summaries += "$label:timeout_budget_exhausted"
                return AndroidScreenCaptureResult.Failed(
                    AndroidScreenCaptureFailureCode.TIMEOUT,
                    boundedDetail(summaries.joinToString(" | ")),
                )
            }
            val result = shell.executeBinary(command, remainingMs)
            if (result.success && result.stdout.isNotEmpty()) {
                return AndroidScreenCaptureResult.Captured(
                    pngBytes = result.stdout,
                    elapsedMs = (nowMs() - startedAt).coerceAtLeast(0L),
                    detail = boundedDetail(result.stderr),
                )
            }
            lastCode = result.failureCode ?: AndroidScreenCaptureFailureCode.EXECUTION_FAILED
            val detail = when {
                result.success -> "empty_stdout"
                else -> result.stderr.ifBlank { "failed" }
            }
            summaries += "$label:${boundedDetail(detail)}"
        }

        return AndroidScreenCaptureResult.Failed(
            lastCode,
            boundedDetail(summaries.joinToString(" | ")),
        )
    }

    override suspend fun captureScreenshot(timeoutMs: Long): AndroidScreenCaptureResult {
        val startedAt = nowMs()
        val deadline = startedAt + timeoutMs.coerceAtLeast(0L)
        val preparation = prepareScreenshot((deadline - nowMs()).coerceAtLeast(0L))
        val readyPreparation = when (preparation) {
            AndroidScreenCapturePreparation.Ready -> AndroidScreenCapturePreparation.Ready
            is AndroidScreenCapturePreparation.Failed -> {
                return AndroidScreenCaptureResult.Failed(preparation.code, preparation.detail)
            }
        }
        val remainingMs = deadline - nowMs()
        if (remainingMs <= 0L) {
            return AndroidScreenCaptureResult.Failed(
                AndroidScreenCaptureFailureCode.TIMEOUT,
                "Screenshot timeout budget exhausted during preparation",
            )
        }
        return capturePreparedScreenshot(readyPreparation, remainingMs)
    }

    private suspend fun executeTap(command: DeviceCommand.Tap): DeviceReceipt {
        val primaryCommand = "input tap ${command.x} ${command.y}"
        val primary = shell.executeWithRetry(primaryCommand, ACTION_TIMEOUT_MS)
        if (primary.success || inputInjectionDenied(primary.output)) {
            return receipt(command, primary)
        }

        val fallback = shell.executeWithRetry(
            "input swipe ${command.x} ${command.y} ${command.x} ${command.y} 120",
            ACTION_TIMEOUT_MS,
        )
        if (fallback.success) return receipt(command, fallback)

        return receipt(
            command,
            RuntimeShellResult(
                success = false,
                output = "primary=${boundedDetail(primary.output)} | fallback=${boundedDetail(fallback.output)}",
                failureCode = fallback.failureCode ?: primary.failureCode,
            ),
        )
    }

    private suspend fun executeShell(command: DeviceCommand, shellCommand: String): DeviceReceipt =
        receipt(command, shell.executeWithRetry(shellCommand, ACTION_TIMEOUT_MS))

    private suspend fun executeLaunch(command: DeviceCommand.LaunchApp): DeviceReceipt {
        if (!PACKAGE_NAME_REGEX.matches(command.packageName)) {
            return receipt(
                command,
                RuntimeShellResult(
                    success = false,
                    output = "Invalid Android package name",
                    failureCode = AndroidScreenCaptureFailureCode.PROCESS_SETUP_FAILED,
                ),
            )
        }

        val primary = shell.executeWithRetry(
            "am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${command.packageName}",
            ACTION_TIMEOUT_MS,
        )
        if (launchSucceeded(primary)) return receipt(command, primary)

        val resolve = shell.executeWithRetry(
            "cmd package resolve-activity --brief --user 0 -c android.intent.category.LAUNCHER ${command.packageName}",
            ACTION_TIMEOUT_MS,
        )
        val component = resolve.output.let(::parseResolveActivityComponent)
        if (resolve.success && component != null) {
            val explicit = shell.executeWithRetry("am start --user 0 -n $component", ACTION_TIMEOUT_MS)
            if (launchSucceeded(explicit)) return receipt(command, explicit)
        }

        val monkey = shell.executeWithRetry(
            "monkey -p ${command.packageName} -c android.intent.category.LAUNCHER 1",
            ACTION_TIMEOUT_MS,
        )
        if (monkey.success) return receipt(command, monkey)

        return receipt(
            command,
            RuntimeShellResult(
                success = false,
                output = "primary=${boundedDetail(primary.output)} | resolve=${boundedDetail(resolve.output)} | monkey=${boundedDetail(monkey.output)}",
                failureCode = monkey.failureCode ?: resolve.failureCode ?: primary.failureCode,
            ),
        )
    }

    private fun receipt(command: DeviceCommand, result: RuntimeShellResult): DeviceReceipt {
        if (result.success) {
            return DeviceReceipt(command, DeviceReceipt.Outcome.SUCCEEDED, boundedDetail(result.output))
        }
        val facts = mutableMapOf(
            "runtime_failure_code" to (result.failureCode ?: AndroidScreenCaptureFailureCode.EXECUTION_FAILED).name,
        )
        if (inputInjectionDenied(result.output)) {
            facts["input_injection_permission_denied"] = "true"
        }
        return DeviceReceipt(
            command = command,
            outcome = DeviceReceipt.Outcome.FAILED,
            detail = boundedDetail(result.output),
            transientFacts = facts,
        )
    }

    private fun unsupported(command: DeviceCommand, detail: String): DeviceReceipt = DeviceReceipt(
        command = command,
        outcome = DeviceReceipt.Outcome.UNSUPPORTED,
        detail = detail,
    )

    private fun launchSucceeded(result: RuntimeShellResult): Boolean = result.success &&
        !result.output.contains("Error: Activity not started", ignoreCase = true) &&
        !result.output.contains("unable to resolve Intent", ignoreCase = true)

    private fun parseResolveActivityComponent(output: String): String? {
        Regex("""name=([^\s]+/[^\s]+)""").find(output)?.groupValues?.get(1)
            ?.takeIf { it.contains('/') }
            ?.let { return it }
        return output.lines().lastOrNull { it.contains('/') && it.trim().matches(Regex("""\S+/\S+""")) }
            ?.trim()
    }

    private companion object {
        const val ACTION_TIMEOUT_MS = 5_000L
        val PACKAGE_NAME_REGEX = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
    }
}

private fun inputInjectionDenied(output: String): Boolean {
    val normalized = output.lowercase()
    return normalized.contains("inject_events") ||
        normalized.contains("injecting input events requires")
}

private fun boundedDetail(detail: String): String = detail.trim().take(700)
