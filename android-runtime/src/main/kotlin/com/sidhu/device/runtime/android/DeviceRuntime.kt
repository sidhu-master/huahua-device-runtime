package com.sidhu.device.runtime.android

import com.sidhu.device.contracts.DeviceCapability
import com.sidhu.device.contracts.DeviceCommand
import com.sidhu.device.contracts.DeviceReceipt

/** Platform-specific executor for the portable device command contract. */
interface DeviceRuntime {
    val capabilities: DeviceCapability

    suspend fun execute(command: DeviceCommand): DeviceReceipt
}
