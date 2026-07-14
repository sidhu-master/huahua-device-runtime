package com.sidhu.device.contracts

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCommandTest {
    @Test
    fun navigationAndObservationNeedNoHumanHandoff() {
        assertFalse(DeviceCommand.Tap(12, 24).requiresHumanHandoff)
        assertFalse(DeviceCommand.Back.requiresHumanHandoff)
        assertFalse(DeviceCommand.Observe.requiresHumanHandoff)
    }

    @Test
    fun sensitiveTextAlwaysNeedsHumanHandoff() {
        assertTrue(DeviceCommand.InputText("123456", sensitive = true).requiresHumanHandoff)
    }
}
