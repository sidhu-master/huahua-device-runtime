package com.sidhu.device.runtime.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAgentPairingRegistryTest {
    @Test
    fun approvedRequestGetsAHostCredentialBoundToTheApprovedHost() {
        var nowMs = 1_000L
        val registry = DeviceAgentPairingRegistry(
            nowMs = { nowMs },
            tokenFactory = { purpose -> "$purpose-token" },
        )
        val card = registry.createInvitation(
            endpoint = "http://192.168.1.10:38473",
            displayName = "Pixel 9",
            ttlMs = 100L,
        )

        val request = registry.requestPairing(
            connectionId = card.connectionId,
            bootstrapToken = card.bootstrapToken,
            hostId = "host-a",
            hostDisplayName = "Codex",
        )
        val grant = registry.approve(request.requestId)

        assertEquals("host-a", grant.hostId)
        assertTrue(registry.authorize("host-a", grant.accessToken))
        assertFalse(registry.authorize("host-b", grant.accessToken))
    }

    @Test
    fun rejectsExpiredOrIncorrectBootstrapCredentials() {
        var nowMs = 1_000L
        val registry = DeviceAgentPairingRegistry(
            nowMs = { nowMs },
            tokenFactory = { purpose -> "$purpose-token" },
        )
        val card = registry.createInvitation(
            endpoint = "http://192.168.1.10:38473",
            displayName = "Pixel 9",
            ttlMs = 100L,
        )

        check(
            runCatching {
                registry.requestPairing(card.connectionId, "wrong", "host-a", "Codex")
            }.isFailure,
        )
        nowMs += 100L
        check(
            runCatching {
                registry.requestPairing(card.connectionId, card.bootstrapToken, "host-a", "Codex")
            }.isFailure,
        )
    }

    @Test
    fun unapprovedPairingRequestExpiresInsteadOfWaitingIndefinitely() {
        var nowMs = 1_000L
        val registry = DeviceAgentPairingRegistry(
            nowMs = { nowMs },
            tokenFactory = { purpose -> "$purpose-token" },
        )
        val card = registry.createInvitation("http://192.168.1.10:38473", "Pixel 9")
        val request = registry.requestPairing(card.connectionId, card.bootstrapToken, "host-a", "Codex")

        nowMs += DeviceAgentPairingRegistry.DEFAULT_PAIRING_REQUEST_TTL_MS

        assertEquals(null, registry.pendingRequest(request.requestId))
        check(runCatching { registry.approve(request.requestId) }.isFailure)
    }
}
