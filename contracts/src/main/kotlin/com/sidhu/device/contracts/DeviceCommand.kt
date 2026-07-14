package com.sidhu.device.contracts

/** A portable action that an already-paired device agent may consider executing. */
sealed interface DeviceCommand {
    /** Signals that the runtime must stop and return control to the person. */
    val requiresHumanHandoff: Boolean

    data class Tap(val x: Int, val y: Int) : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data class Swipe(
        val startX: Int,
        val startY: Int,
        val endX: Int,
        val endY: Int,
        val durationMs: Long = 300L,
    ) : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data class LongPress(
        val x: Int,
        val y: Int,
        val durationMs: Long = 500L,
    ) : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data class LaunchApp(val packageName: String) : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data class InputText(
        val value: String,
        val sensitive: Boolean = false,
    ) : DeviceCommand {
        override val requiresHumanHandoff = sensitive
    }

    data object Back : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data object Home : DeviceCommand {
        override val requiresHumanHandoff = false
    }

    data object Observe : DeviceCommand {
        override val requiresHumanHandoff = false
    }
}
