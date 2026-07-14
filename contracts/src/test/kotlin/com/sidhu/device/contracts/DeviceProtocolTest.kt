package com.sidhu.device.contracts

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceProtocolTest {
    @Test
    fun versionIsStableForInitialAgentAndClientPairing() {
        assertEquals("v1", DeviceProtocol.VERSION)
    }
}
