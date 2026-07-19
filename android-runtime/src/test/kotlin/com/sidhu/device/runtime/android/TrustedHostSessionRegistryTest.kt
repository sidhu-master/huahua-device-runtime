package com.sidhu.device.runtime.android

import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class TrustedHostSessionRegistryTest {
    @Test
    fun validP256SignatureCompletesOneChallengeOnlyOnce() = runTest {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val registry = TrustedHostSessionRegistry(
            trustedHosts = TrustedHostLookup { hostId ->
                TrustedHost(hostId, keys.public.encoded)
            },
            authorize = { true },
            tokenFactory = { "short-lived-token" },
        )

        val challenge = registry.createChallenge("host-a")
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(keys.private)
            update(Base64.getUrlDecoder().decode(challenge.challenge))
            Base64.getUrlEncoder().withoutPadding().encodeToString(sign())
        }

        assertEquals("short-lived-token", registry.completeChallenge("host-a", challenge.challengeId, signature)?.accessToken)
        assertNull(registry.completeChallenge("host-a", challenge.challengeId, signature))
    }

    @Test
    fun serverRejectedAuthorizationNeverCreatesToken() = runTest {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val registry = TrustedHostSessionRegistry(
            trustedHosts = TrustedHostLookup { hostId -> TrustedHost(hostId, keys.public.encoded) },
            authorize = { false },
            tokenFactory = { error("A rejected host must not receive a token") },
        )
        val challenge = registry.createChallenge("host-a")
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(keys.private)
            update(Base64.getUrlDecoder().decode(challenge.challenge))
            Base64.getUrlEncoder().withoutPadding().encodeToString(sign())
        }

        assertNull(registry.completeChallenge("host-a", challenge.challengeId, signature))
        assertFalse(registry.hasActiveGrant("host-a"))
    }
}
