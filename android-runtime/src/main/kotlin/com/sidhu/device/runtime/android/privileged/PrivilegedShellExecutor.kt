package com.sidhu.device.runtime.android.privileged

import com.sidhu.device.runtime.android.AndroidScreenCaptureFailureCode
import java.lang.reflect.InvocationTargetException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal data class RuntimeShellResult(
    val success: Boolean,
    val output: String,
    val failureCode: AndroidScreenCaptureFailureCode? = null,
)

internal interface RestrictedShellExecutor {
    suspend fun prepare(timeoutMs: Long): RuntimeShellResult
    suspend fun execute(command: String, timeoutMs: Long): RuntimeShellResult
    suspend fun executeBinary(command: List<String>, timeoutMs: Long): RuntimeBinaryResult
}

internal data class RuntimeBinaryResult(
    val success: Boolean,
    val stdout: ByteArray = ByteArray(0),
    val stderr: String = "",
    val failureCode: AndroidScreenCaptureFailureCode? = null,
)

/**
 * Host-app boundary for starting a restricted privileged process.
 *
 * The open runtime deliberately does not depend on a particular Android
 * privilege provider. Product apps supply this bridge from their private
 * integration layer.
 */
interface PrivilegedProcessBridge {
    fun isReady(): Boolean
    fun start(command: Array<String>): Process?
}

internal class RetryingShellExecutor(
    private val readinessGate: RuntimeReadinessGate,
    private val delegate: RestrictedShellExecutor,
) {
    suspend fun prepareScreenshot(timeoutMs: Long): RuntimeShellResult {
        val readiness = readinessGate.awaitReady(timeoutMs)
        if (!readiness.ready) return readinessFailure(readiness)
        return delegate.prepare(timeoutMs)
    }

    suspend fun executeWithRetry(command: String, timeoutMs: Long): RuntimeShellResult {
        val initialReadiness = readinessGate.awaitReady(INITIAL_ACTION_READINESS_TIMEOUT_MS)
        if (!initialReadiness.ready) return readinessFailure(initialReadiness)

        val first = delegate.execute(command, timeoutMs)
        if (first.success || !retryable(first.output)) return first

        delay(RETRY_DELAY_MS)
        val retryReadiness = readinessGate.awaitReady(RETRY_ACTION_READINESS_TIMEOUT_MS)
        if (!retryReadiness.ready) {
            val retryFailure = readinessFailure(retryReadiness)
            return RuntimeShellResult(
                success = false,
                output = "first=${bounded(first.output)} | retry=${bounded(retryFailure.output)}",
                failureCode = retryFailure.failureCode ?: first.failureCode,
            )
        }

        val retry = delegate.execute(command, timeoutMs)
        if (retry.success) return retry

        return RuntimeShellResult(
            success = false,
            output = "first=${bounded(first.output)} | retry=${bounded(retry.output)}",
            failureCode = retry.failureCode ?: first.failureCode,
        )
    }

    suspend fun executeBinary(command: List<String>, timeoutMs: Long): RuntimeBinaryResult =
        delegate.executeBinary(command, timeoutMs)

    private fun readinessFailure(readiness: RuntimeReadiness): RuntimeShellResult = RuntimeShellResult(
        success = false,
        output = bounded(readiness.detail.ifBlank { "runtime not ready" }),
        failureCode = readiness.failureCode ?: AndroidScreenCaptureFailureCode.NOT_READY,
    )

    private companion object {
        const val INITIAL_ACTION_READINESS_TIMEOUT_MS = 1_800L
        const val RETRY_ACTION_READINESS_TIMEOUT_MS = 2_500L
        const val RETRY_DELAY_MS = 120L
    }
}

internal class PrivilegedShellExecutor(
    private val bridge: PrivilegedProcessBridge,
) : RestrictedShellExecutor {

    override suspend fun prepare(timeoutMs: Long): RuntimeShellResult = withContext(Dispatchers.IO) {
        if (!bridge.isReady()) return@withContext bridgeUnavailable()
        RuntimeShellResult(success = true, output = "")
    }

    override suspend fun execute(command: String, timeoutMs: Long): RuntimeShellResult {
        val result = executeProcess(arrayOf("sh", "-c", command), timeoutMs)
        return RuntimeShellResult(
            success = result.success,
            output = result.detail,
            failureCode = result.failureCode,
        )
    }

    override suspend fun executeBinary(command: List<String>, timeoutMs: Long): RuntimeBinaryResult {
        if (command.isEmpty()) {
            return RuntimeBinaryResult(
                success = false,
                stderr = "Empty binary command",
                failureCode = AndroidScreenCaptureFailureCode.PROCESS_SETUP_FAILED,
            )
        }
        val result = executeProcess(command.toTypedArray(), timeoutMs)
        return RuntimeBinaryResult(
            success = result.success,
            stdout = result.stdout,
            stderr = result.detail,
            failureCode = result.failureCode,
        )
    }

    private suspend fun executeProcess(command: Array<String>, timeoutMs: Long): ProcessExecution {
        if (timeoutMs <= 0L) {
            return ProcessExecution.failure(
                "Process timeout budget exhausted",
                AndroidScreenCaptureFailureCode.TIMEOUT,
            )
        }
        if (!bridge.isReady()) return ProcessExecution.from(bridgeUnavailable())

        val process = try {
            bridge.start(command)
                ?: return ProcessExecution.failure(
                    "Privileged process bridge did not return a Process",
                    AndroidScreenCaptureFailureCode.PROCESS_SETUP_FAILED,
                )
        } catch (error: Throwable) {
            return ProcessExecution.failure(
                "Privileged process start failed: ${bounded(rootMessage(error))}",
                AndroidScreenCaptureFailureCode.PROCESS_SETUP_FAILED,
            )
        }

        return collectProcess(process, timeoutMs)
    }

    private suspend fun collectProcess(process: Process, timeoutMs: Long): ProcessExecution =
        withContext(Dispatchers.IO) {
            coroutineScope {
                val stdout = async(Dispatchers.IO) { process.inputStream.readBytes() }
                val stderr = async(Dispatchers.IO) { process.errorStream.readBytes() }
                try {
                    if (!waitForProcessExit(process, timeoutMs)) {
                        process.destroyForcibly()
                        stdout.cancel()
                        stderr.cancel()
                        return@coroutineScope ProcessExecution.failure(
                            "Process timed out after ${timeoutMs}ms",
                            AndroidScreenCaptureFailureCode.TIMEOUT,
                        )
                    }

                    val stdoutBytes = stdout.await()
                    val stderrText = stderr.await().decodeToString()
                    val exitCode = process.exitValue()
                    val detail = bounded(
                        listOf(
                            stderrText.takeIf { it.isNotBlank() },
                            if (exitCode == 0) null else "exit=$exitCode",
                        ).filterNotNull().joinToString(" | ").ifBlank { "" },
                    )
                    if (exitCode == 0) {
                        ProcessExecution(success = true, stdout = stdoutBytes, detail = detail)
                    } else {
                        ProcessExecution.failure(
                            detail.ifBlank { "Process exited with $exitCode" },
                            AndroidScreenCaptureFailureCode.EXECUTION_FAILED,
                            stdoutBytes,
                        )
                    }
                } catch (error: Throwable) {
                    process.destroyForcibly()
                    stdout.cancel()
                    stderr.cancel()
                    ProcessExecution.failure(
                        "Process execution failed: ${bounded(rootMessage(error))}",
                        AndroidScreenCaptureFailureCode.EXECUTION_FAILED,
                    )
                }
            }
        }

    private fun bridgeUnavailable(): RuntimeShellResult = RuntimeShellResult(
        success = false,
        output = "Privileged process bridge unavailable",
        failureCode = AndroidScreenCaptureFailureCode.BINDER_UNAVAILABLE,
    )
}

internal suspend fun waitForProcessExit(
    process: Process,
    timeoutMs: Long,
    pollMs: Long = 20L,
): Boolean {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs.coerceAtLeast(0L))
    while (System.nanoTime() < deadline) {
        if (runCatching { process.exitValue() }.isSuccess) return true
        delay(pollMs.coerceAtLeast(1L))
    }
    return runCatching { process.exitValue() }.isSuccess
}

private data class ProcessExecution(
    val success: Boolean,
    val stdout: ByteArray = ByteArray(0),
    val detail: String = "",
    val failureCode: AndroidScreenCaptureFailureCode? = null,
) {
    companion object {
        fun failure(
            detail: String,
            failureCode: AndroidScreenCaptureFailureCode,
            stdout: ByteArray = ByteArray(0),
        ): ProcessExecution = ProcessExecution(
            success = false,
            stdout = stdout,
            detail = bounded(detail),
            failureCode = failureCode,
        )

        fun from(result: RuntimeShellResult): ProcessExecution = ProcessExecution(
            success = result.success,
            detail = result.output,
            failureCode = result.failureCode,
        )
    }
}

private fun retryable(output: String): Boolean {
    val normalized = output.lowercase()
    return output.isBlank() ||
        normalized.contains("bridge") ||
        normalized.contains("binder") ||
        normalized.contains("timeout") ||
        normalized.contains("not ready") ||
        normalized.contains("not available")
}

private fun rootMessage(error: Throwable): String =
    (error as? InvocationTargetException)?.targetException?.message ?: error.message ?: error.javaClass.simpleName

private fun bounded(detail: String): String = detail.trim().take(MAX_DETAIL_LENGTH)

private const val MAX_DETAIL_LENGTH = 700
