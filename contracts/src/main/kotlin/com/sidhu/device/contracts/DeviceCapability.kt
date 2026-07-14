package com.sidhu.device.contracts

/** Capabilities advertised by one installed device agent. */
data class DeviceCapability(
    val protocolVersion: String = DeviceProtocol.VERSION,
    val supportsScreenshots: Boolean,
    val supportsUiTree: Boolean,
    val supportsScreenRecording: Boolean,
    val supportsPerformanceMetrics: Boolean,
)
