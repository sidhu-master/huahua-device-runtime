package com.sidhu.device.runtime.android

/**
 * Ensures exactly one paired AI host has an active control lease for this
 * installed device. Transport-level pairing is deliberately out of scope.
 */
class DeviceLeaseCoordinator(
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private var activeLease: ActiveLease? = null

    @Synchronized
    fun acquire(hostId: String, ttlMs: Long = DEFAULT_LEASE_TTL_MS): Boolean {
        require(hostId.isNotBlank()) { "hostId is required" }
        require(ttlMs > 0L) { "ttlMs must be positive" }
        expireLeaseIfNeeded()
        if (activeLease != null) return false
        activeLease = ActiveLease(hostId = hostId, expiresAtMs = nowMs() + ttlMs)
        return true
    }

    @Synchronized
    fun release(hostId: String): Boolean {
        expireLeaseIfNeeded()
        if (activeLease?.hostId != hostId) return false
        activeLease = null
        return true
    }

    @Synchronized
    fun currentHolder(): String? {
        expireLeaseIfNeeded()
        return activeLease?.hostId
    }

    @Synchronized
    fun isHeldBy(hostId: String): Boolean = currentHolder() == hostId

    @Synchronized
    fun currentLeaseExpiresAtMs(): Long? {
        expireLeaseIfNeeded()
        return activeLease?.expiresAtMs
    }

    private fun expireLeaseIfNeeded() {
        if (activeLease?.expiresAtMs?.let { it <= nowMs() } == true) activeLease = null
    }

    private data class ActiveLease(
        val hostId: String,
        val expiresAtMs: Long,
    )

    companion object {
        const val DEFAULT_LEASE_TTL_MS: Long = 60_000L
    }
}
