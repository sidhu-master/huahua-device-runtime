package com.sidhu.device.contracts

/** Controls whether a host may persist its caller-supplied observation as step evidence. */
enum class DeviceExecutionRecordMode {
    NORMAL,
    SUPPRESS_SCREENSHOT,
}

/**
 * One externally planned device step.
 *
 * [stepSummary] is intentionally a bounded, user-visible execution explanation. It is not a
 * model chain-of-thought and must be safe for a host to place in its local conversation history.
 */
class DeviceExecutionStep(
    val stepId: String,
    stepSummary: String,
    val command: DeviceCommand,
    val recordMode: DeviceExecutionRecordMode = DeviceExecutionRecordMode.NORMAL,
) {
    val stepSummary: String = stepSummary
        .replace(Regex("\\s+"), " ")
        .trim()
        .take(MAX_STEP_SUMMARY_LENGTH)

    init {
        require(stepId.isNotBlank()) { "stepId must not be blank" }
        require(stepSummary.isNotBlank()) { "stepSummary must not be blank" }
    }

    companion object {
        const val MAX_STEP_SUMMARY_LENGTH = 500
    }
}

/** Pairs the host-visible step with the unmodified receipt produced by the device runtime. */
data class DeviceExecutionStepResult(
    val step: DeviceExecutionStep,
    val receipt: DeviceReceipt,
)
