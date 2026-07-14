package com.sidhu.device.runtime.android

/**
 * Ensures exactly one paired AI host has an active control lease for this
 * installed device. Transport-level pairing is deliberately out of scope.
 */
class DeviceLeaseCoordinator {
    private var holder: String? = null

    @Synchronized
    fun acquire(hostId: String): Boolean {
        if (holder != null) return false
        holder = hostId
        return true
    }

    @Synchronized
    fun release(hostId: String): Boolean {
        if (holder != hostId) return false
        holder = null
        return true
    }

    @Synchronized
    fun currentHolder(): String? = holder
}
