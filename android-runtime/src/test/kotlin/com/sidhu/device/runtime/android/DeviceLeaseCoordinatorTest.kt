package com.sidhu.device.runtime.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceLeaseCoordinatorTest {
    @Test
    fun secondHostCannotAcquireAnActiveLease() {
        val coordinator = DeviceLeaseCoordinator()

        assertTrue(coordinator.acquire("host-a"))
        assertFalse(coordinator.acquire("host-b"))
        assertTrue(coordinator.release("host-a"))
        assertTrue(coordinator.acquire("host-b"))
    }
}
