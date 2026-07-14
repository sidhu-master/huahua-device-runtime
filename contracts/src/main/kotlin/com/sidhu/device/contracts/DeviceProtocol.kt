package com.sidhu.device.contracts

/**
 * Protocol version shared by external AI clients and installed device agents.
 *
 * A connection card must declare this value before either side accepts a
 * pairing or command. Version changes are explicit compatibility boundaries.
 */
object DeviceProtocol {
    const val VERSION = "v1"
}
