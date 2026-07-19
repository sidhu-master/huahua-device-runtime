package com.sidhu.device.contracts

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProtocolTest {
    @Test
    fun v2IsTheCurrentProtocolWhileV1RemainsBootstrapCompatible() {
        assertEquals("v2", DeviceProtocol.VERSION)
        assertEquals("v1", DeviceProtocol.LEGACY_VERSION)
    }
}
