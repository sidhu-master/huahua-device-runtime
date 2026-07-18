package com.sidhu.device.contracts

import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Base64

/**
 * A short-lived invitation created by the installed device for a local AI host.
 * The bootstrap token is deliberately opaque: only the device can redeem it.
 */
data class DeviceConnectionCard(
    val connectionId: String,
    val endpoint: String,
    val bootstrapToken: String,
    val displayName: String,
    val expiresAtMs: Long,
    val deviceId: String? = null,
    val discoveryServiceType: String? = null,
) {
    init {
        require(connectionId.isNotBlank()) { "connectionId is required" }
        require(bootstrapToken.isNotBlank()) { "bootstrapToken is required" }
        require(displayName.isNotBlank()) { "displayName is required" }
        require(expiresAtMs > 0L) { "expiresAtMs must be positive" }
        val endpointUri = runCatching { URI(endpoint) }.getOrElse { throw IllegalArgumentException("invalid endpoint", it) }
        require(endpointUri.scheme == "http" || endpointUri.scheme == "https") { "endpoint must use http or https" }
        require(!endpointUri.host.isNullOrBlank()) { "endpoint host is required" }
        require((deviceId == null) == (discoveryServiceType == null)) {
            "deviceId and discoveryServiceType must be provided together"
        }
        if (deviceId != null) {
            require(deviceId.isNotBlank()) { "deviceId is required" }
            require(discoveryServiceType == DeviceProtocol.TRUSTED_DISCOVERY_SERVICE_TYPE) {
                "unsupported discovery service type"
            }
        }
    }

    fun isUsableAt(nowMs: Long = System.currentTimeMillis()): Boolean = nowMs < expiresAtMs
    val supportsTrustedReconnect: Boolean get() = deviceId != null && discoveryServiceType != null

    fun serialize(): String = buildString {
        append("huahua://device-agent/")
        append(if (supportsTrustedReconnect) DeviceProtocol.VERSION else DeviceProtocol.LEGACY_VERSION)
        append('?')
        append("connection_id=").append(encode(connectionId))
        append("&endpoint=").append(encode(endpoint))
        append("&token=").append(encode(bootstrapToken))
        append("&name=").append(encode(displayName))
        append("&expires_at_ms=").append(expiresAtMs)
        if (supportsTrustedReconnect) {
            append("&device_id=").append(encode(requireNotNull(deviceId)))
            append("&discovery_service_type=").append(encode(requireNotNull(discoveryServiceType)))
        }
    }

    companion object {
        fun parse(serialized: String): DeviceConnectionCard {
            val uri = runCatching { URI(serialized) }.getOrElse { throw IllegalArgumentException("invalid connection card", it) }
            require(uri.scheme == "huahua" && uri.host == "device-agent" &&
                (uri.path == "/${DeviceProtocol.LEGACY_VERSION}" || uri.path == "/${DeviceProtocol.VERSION}")) {
                "unsupported connection card"
            }
            val fields = uri.rawQuery.orEmpty()
                .split('&')
                .filter { it.isNotBlank() }
                .associate { part ->
                    val separator = part.indexOf('=')
                    require(separator > 0) { "invalid connection card field" }
                    part.substring(0, separator) to part.substring(separator + 1)
                }
            val isV2 = uri.path == "/${DeviceProtocol.VERSION}"
            return DeviceConnectionCard(
                connectionId = decode(fields.requireValue("connection_id")),
                endpoint = decode(fields.requireValue("endpoint")),
                bootstrapToken = decode(fields.requireValue("token")),
                displayName = decode(fields.requireValue("name")),
                expiresAtMs = fields.requireValue("expires_at_ms").toLongOrNull()
                    ?: throw IllegalArgumentException("invalid expires_at_ms"),
                deviceId = fields["device_id"]?.let(::decode).also {
                    if (isV2) require(it != null) { "missing device_id" }
                },
                discoveryServiceType = fields["discovery_service_type"]?.let(::decode).also {
                    if (isV2) require(it != null) { "missing discovery_service_type" }
                },
            )
        }

        private fun Map<String, String>.requireValue(key: String): String =
            this[key]?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("missing $key")

        private fun encode(value: String): String = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(value.toByteArray(StandardCharsets.UTF_8))

        private fun decode(value: String): String = runCatching {
            String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8)
        }.getOrElse { throw IllegalArgumentException("invalid encoded connection card field", it) }
    }
}
