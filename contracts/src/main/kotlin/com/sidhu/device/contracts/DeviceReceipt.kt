package com.sidhu.device.contracts

/** Result returned for one device command; evidence lives outside this compact receipt. */
data class DeviceReceipt(
    val command: DeviceCommand,
    val outcome: Outcome,
    val detail: String = "",
    val transientFacts: Map<String, String> = emptyMap(),
) {
    enum class Outcome {
        SUCCEEDED,
        FAILED,
        HANDOFF_REQUIRED,
        UNSUPPORTED,
    }
}
