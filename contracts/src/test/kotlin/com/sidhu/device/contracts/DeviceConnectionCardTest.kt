package com.sidhu.device.contracts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceConnectionCardTest {
    @Test
    fun roundTripsTheShortLivedLanBootstrapDetails() {
        val card = DeviceConnectionCard(
            connectionId = "connection-1",
            endpoint = "http://192.168.1.10:38473",
            bootstrapToken = "bootstrap-secret",
            displayName = "Pixel 9",
            expiresAtMs = 1_000L,
        )

        val restored = DeviceConnectionCard.parse(card.serialize())

        assertEquals(card, restored)
        assertTrue(restored.isUsableAt(999L))
        assertFalse(restored.isUsableAt(1_000L))
    }

    @Test
    fun rejectsUnknownOrIncompleteCardFormats() {
        check(runCatching { DeviceConnectionCard.parse("https://example.com") }.isFailure)
        check(runCatching { DeviceConnectionCard.parse("huahua://device-agent/v1?connection_id=x") }.isFailure)
    }

    @Test
    fun v2CardCarriesTheStableDiscoveryIdentity() {
        val card = DeviceConnectionCard(
            connectionId = "connection-2",
            endpoint = "http://192.168.1.10:38473",
            bootstrapToken = "bootstrap-secret",
            displayName = "Pixel 9",
            expiresAtMs = 1_000L,
            deviceId = "agent-device-a",
            discoveryServiceType = "_huahua-device-agent._tcp.",
        )

        val restored = DeviceConnectionCard.parse(card.serialize())

        assertEquals("agent-device-a", restored.deviceId)
        assertEquals("_huahua-device-agent._tcp.", restored.discoveryServiceType)
        assertTrue(restored.supportsTrustedReconnect)
    }
}
