package com.sidhu.device.runtime.android

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

/**
 * Pure in-memory challenge authority for already trusted LAN hosts.
 *
 * The Android app owns persistence and server verification. This registry only
 * verifies possession of the registered P-256 public key and issues a short
 * lived token after the app confirms the host is still authorized server-side.
 */
class TrustedHostSessionRegistry(
    private val trustedHosts: TrustedHostLookup,
    private val authorize: suspend (TrustedHost) -> Boolean,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val tokenFactory: (String) -> String = ::secureToken,
) {
    private val challenges = mutableMapOf<String, ChallengeState>()
    private val grants = mutableMapOf<String, HostAccessGrant>()

    @Synchronized
    fun createChallenge(hostId: String, ttlMs: Long = DEFAULT_CHALLENGE_TTL_MS): TrustedHostChallenge {
        require(hostId.isNotBlank()) { "hostId is required" }
        require(ttlMs > 0L) { "ttlMs must be positive" }
        cleanupExpired()
        checkNotNull(trustedHosts.find(hostId)?.takeIf { it.hostId == hostId }) { "trusted host is unavailable" }
        val challenge = ByteArray(CHALLENGE_BYTES).also(secureRandom::nextBytes)
        return TrustedHostChallenge(
            challengeId = UUID.randomUUID().toString(),
            challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(challenge),
            expiresAtMs = nowMs() + ttlMs,
        ).also { created ->
            challenges[created.challengeId] = ChallengeState(hostId, challenge, created.expiresAtMs)
        }
    }

    /**
     * A challenge is removed before verification, so it cannot be replayed
     * whether verification succeeds or fails.
     */
    suspend fun completeChallenge(
        hostId: String,
        challengeId: String,
        signature: String,
        ttlMs: Long = DEFAULT_HOST_ACCESS_TTL_MS,
    ): HostAccessGrant? {
        require(hostId.isNotBlank()) { "hostId is required" }
        require(challengeId.isNotBlank()) { "challengeId is required" }
        require(signature.isNotBlank()) { "signature is required" }
        require(ttlMs > 0L) { "ttlMs must be positive" }
        val state = synchronized(this) {
            cleanupExpired()
            challenges.remove(challengeId)?.takeIf { it.hostId == hostId }
        } ?: return null
        val host = trustedHosts.find(hostId)?.takeIf { it.hostId == hostId } ?: return null
        if (!verifyP256Signature(host.publicKeySpki, state.challenge, signature)) return null
        if (!authorize(host)) return null
        val accessToken = tokenFactory("trusted-host-access")
        require(accessToken.isNotBlank()) { "tokenFactory returned an empty trusted host token" }
        return synchronized(this) {
            cleanupExpired()
            HostAccessGrant(hostId, accessToken, nowMs() + ttlMs).also { grant ->
                grants[grant.accessToken] = grant
            }
        }
    }

    @Synchronized
    fun authorize(hostId: String, accessToken: String): Boolean {
        cleanupExpired()
        val grant = grants[accessToken] ?: return false
        return grant.hostId == hostId && MessageDigest.isEqual(
            grant.accessToken.toByteArray(Charsets.UTF_8),
            accessToken.toByteArray(Charsets.UTF_8),
        )
    }

    @Synchronized
    fun hasActiveGrant(hostId: String): Boolean {
        cleanupExpired()
        return grants.values.any { it.hostId == hostId }
    }

    @Synchronized
    private fun cleanupExpired() {
        val now = nowMs()
        challenges.entries.removeAll { (_, value) -> value.expiresAtMs <= now }
        grants.entries.removeAll { (_, value) -> value.expiresAtMs <= now }
    }

    private fun verifyP256Signature(publicKeySpki: ByteArray, challenge: ByteArray, encodedSignature: String): Boolean = runCatching {
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicKeySpki))
        require(publicKey is ECPublicKey && publicKey.params.curve.field.fieldSize == 256) { "trusted host key must be P-256" }
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey)
            update(challenge)
            verify(Base64.getUrlDecoder().decode(encodedSignature))
        }
    }.getOrDefault(false)

    private data class ChallengeState(
        val hostId: String,
        val challenge: ByteArray,
        val expiresAtMs: Long,
    )

    data class TrustedHostChallenge(
        val challengeId: String,
        val challenge: String,
        val expiresAtMs: Long,
    )

    data class HostAccessGrant(
        val hostId: String,
        val accessToken: String,
        val expiresAtMs: Long,
    )

    companion object {
        const val DEFAULT_CHALLENGE_TTL_MS = 60L * 1000L
        const val DEFAULT_HOST_ACCESS_TTL_MS = 10L * 60L * 1000L
        private const val CHALLENGE_BYTES = 32
        private val secureRandom = SecureRandom()

        private fun secureToken(@Suppress("UNUSED_PARAMETER") purpose: String): String = ByteArray(32)
            .also(secureRandom::nextBytes)
            .let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
    }
}

fun interface TrustedHostLookup {
    fun find(hostId: String): TrustedHost?
}

data class TrustedHost(
    val hostId: String,
    val publicKeySpki: ByteArray,
)
