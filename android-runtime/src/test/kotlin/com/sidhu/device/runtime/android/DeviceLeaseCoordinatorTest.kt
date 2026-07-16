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

    @Test
    fun expiredLeaseStopsBlockingTheNextApprovedHost() {
        var nowMs = 1_000L
        val coordinator = DeviceLeaseCoordinator(nowMs = { nowMs })

        assertTrue(coordinator.acquire("host-a", ttlMs = 100L))
        nowMs += 99L
        assertFalse(coordinator.acquire("host-b", ttlMs = 100L))
        nowMs += 1L
        assertTrue(coordinator.acquire("host-b", ttlMs = 100L))
        assertTrue(coordinator.isHeldBy("host-b"))
    }
}
