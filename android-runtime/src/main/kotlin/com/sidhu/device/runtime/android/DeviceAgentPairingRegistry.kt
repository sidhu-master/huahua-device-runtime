package com.sidhu.device.runtime.android

import com.sidhu.device.contracts.DeviceConnectionCard
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

/**
 * In-memory authority for short-lived connection cards and explicit first-host approval.
 * Persisting approved hosts is intentionally left to the Android app layer.
 */
class DeviceAgentPairingRegistry(
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val tokenFactory: (String) -> String = ::secureToken,
) {
    private val invitations = mutableMapOf<String, Invitation>()
    private val requests = mutableMapOf<String, PairingRequest>()
    private val grants = mutableMapOf<String, PairingGrant>()
    private val approvedRequests = mutableMapOf<String, ApprovedRequest>()

    @Synchronized
    fun createInvitation(
        endpoint: String,
        displayName: String,
        ttlMs: Long = DEFAULT_INVITATION_TTL_MS,
    ): DeviceConnectionCard {
        require(ttlMs > 0L) { "ttlMs must be positive" }
        cleanupExpired()
        val connectionId = UUID.randomUUID().toString()
        val bootstrapToken = tokenFactory("bootstrap")
        require(bootstrapToken.isNotBlank()) { "tokenFactory returned an empty bootstrap token" }
        val expiresAtMs = nowMs() + ttlMs
        invitations[connectionId] = Invitation(bootstrapToken, expiresAtMs)
        return DeviceConnectionCard(
            connectionId = connectionId,
            endpoint = endpoint,
            bootstrapToken = bootstrapToken,
            displayName = displayName,
            expiresAtMs = expiresAtMs,
        )
    }

    /**
     * Replaces the current unpaired invitation without persisting its bootstrap token.
     * A previously shared card must no longer be redeemable after this call.
     */
    @Synchronized
    fun refreshInvitation(
        endpoint: String,
        displayName: String,
    ): DeviceConnectionCard {
        invitations.clear()
        return createInvitation(endpoint, displayName)
    }

    @Synchronized
    fun requestPairing(
        connectionId: String,
        bootstrapToken: String,
        hostId: String,
        hostDisplayName: String,
    ): PairingRequest {
        require(hostId.isNotBlank()) { "hostId is required" }
        require(hostDisplayName.isNotBlank()) { "hostDisplayName is required" }
        cleanupExpired()
        val invitation = invitations[connectionId] ?: throw SecurityException("connection card is unavailable")
        if (invitation.used || !tokensMatch(invitation.bootstrapToken, bootstrapToken)) {
            throw SecurityException("connection card is invalid")
        }
        invitation.used = true
        val request = PairingRequest(
            requestId = UUID.randomUUID().toString(),
            hostId = hostId,
            hostDisplayName = hostDisplayName,
            requestedAtMs = nowMs(),
            expiresAtMs = nowMs() + DEFAULT_PAIRING_REQUEST_TTL_MS,
        )
        requests[request.requestId] = request
        return request
    }

    @Synchronized
    fun pendingRequest(requestId: String): PairingRequest? {
        cleanupExpired()
        return requests[requestId]
    }

    @Synchronized
    fun approve(requestId: String, ttlMs: Long = DEFAULT_HOST_ACCESS_TTL_MS): PairingGrant {
        require(ttlMs > 0L) { "ttlMs must be positive" }
        cleanupExpired()
        val request = requests.remove(requestId) ?: throw IllegalArgumentException("pairing request is unavailable")
        val accessToken = tokenFactory("host-access")
        require(accessToken.isNotBlank()) { "tokenFactory returned an empty host access token" }
        return PairingGrant(
            hostId = request.hostId,
            accessToken = accessToken,
            expiresAtMs = nowMs() + ttlMs,
        ).also { grant ->
            grants[grant.accessToken] = grant
            approvedRequests[requestId] = ApprovedRequest(request.hostId, grant)
        }
    }

    @Synchronized
    fun reject(requestId: String): Boolean = requests.remove(requestId) != null

    @Synchronized
    fun authorize(hostId: String, accessToken: String): Boolean {
        cleanupExpired()
        val grant = grants[accessToken] ?: return false
        return grant.hostId == hostId && tokensMatch(grant.accessToken, accessToken)
    }

    @Synchronized
    fun approvedGrant(requestId: String, hostId: String): PairingGrant? {
        cleanupExpired()
        return approvedRequests[requestId]?.takeIf { it.hostId == hostId }?.grant
    }

    @Synchronized
    private fun cleanupExpired() {
        val now = nowMs()
        invitations.entries.removeAll { (_, invitation) -> invitation.expiresAtMs <= now }
        requests.entries.removeAll { (_, request) -> request.expiresAtMs <= now }
        grants.entries.removeAll { (_, grant) -> grant.expiresAtMs <= now }
        approvedRequests.entries.removeAll { (_, approved) -> approved.grant.expiresAtMs <= now }
    }

    private fun tokensMatch(expected: String, actual: String): Boolean = MessageDigest.isEqual(
        expected.toByteArray(StandardCharsets.UTF_8),
        actual.toByteArray(StandardCharsets.UTF_8),
    )

    private data class Invitation(
        val bootstrapToken: String,
        val expiresAtMs: Long,
        var used: Boolean = false,
    )

    private data class ApprovedRequest(val hostId: String, val grant: PairingGrant)

    data class PairingRequest(
        val requestId: String,
        val hostId: String,
        val hostDisplayName: String,
        val requestedAtMs: Long,
        val expiresAtMs: Long,
    )

    data class PairingGrant(
        val hostId: String,
        val accessToken: String,
        val expiresAtMs: Long,
    )

    companion object {
        const val DEFAULT_INVITATION_TTL_MS = 15L * 60L * 1000L
        const val DEFAULT_PAIRING_REQUEST_TTL_MS = 5L * 60L * 1000L
        const val DEFAULT_HOST_ACCESS_TTL_MS = 24L * 60L * 60L * 1000L
        private val secureRandom = SecureRandom()

        private fun secureToken(@Suppress("UNUSED_PARAMETER") purpose: String): String = ByteArray(32)
            .also(secureRandom::nextBytes)
            .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    }
}
