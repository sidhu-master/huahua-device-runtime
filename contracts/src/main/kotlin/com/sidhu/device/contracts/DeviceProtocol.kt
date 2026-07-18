package com.sidhu.device.contracts

/**
 * Protocol version shared by external AI clients and installed device agents.
 *
 * A connection card must declare this value before either side accepts a
 * pairing or command. Version changes are explicit compatibility boundaries.
 */
object DeviceProtocol {
    const val VERSION = "v2"
    const val LEGACY_VERSION = "v1"
    const val TRUSTED_DISCOVERY_SERVICE_TYPE = "_huahua-device-agent._tcp."
}
