package com.sidhu.device.uiautomationhelper

internal enum class SnapshotWindowKind {
    APPLICATION,
    INPUT_METHOD,
    ACCESSIBILITY_OVERLAY,
    SYSTEM,
    OTHER,
}

internal data class SnapshotWindowDescriptor(
    val index: Int,
    val kind: SnapshotWindowKind,
    val active: Boolean,
    val focused: Boolean,
    val rootAvailable: Boolean,
)

internal data class SnapshotWindowPlan(
    val selectedIndices: List<Int>,
    val degradedReasonCode: String?,
)

/** Selects only the foreground app and focused/active UI surfaces that can affect interaction. */
internal object SnapshotWindowPolicy {
    fun select(windows: List<SnapshotWindowDescriptor>): SnapshotWindowPlan {
        val applications = windows.filter { it.kind == SnapshotWindowKind.APPLICATION }
        val selectedApplications = applications.filter { it.active }.ifEmpty {
            applications.filter { it.focused }
        }
        val supplemental = windows.filter { window ->
            (window.kind == SnapshotWindowKind.INPUT_METHOD ||
                window.kind == SnapshotWindowKind.ACCESSIBILITY_OVERLAY) &&
                (window.active || window.focused)
        }
        val selected = (selectedApplications + supplemental).distinctBy { it.index }.sortedBy { it.index }
        val degradedReasonCode = selected.firstNotNullOfOrNull { window ->
            if (window.rootAvailable) return@firstNotNullOfOrNull null
            when (window.kind) {
                SnapshotWindowKind.INPUT_METHOD -> "INPUT_METHOD_WINDOW_ROOT_UNAVAILABLE"
                SnapshotWindowKind.ACCESSIBILITY_OVERLAY -> "ACCESSIBILITY_OVERLAY_WINDOW_ROOT_UNAVAILABLE"
                else -> null
            }
        }
        return SnapshotWindowPlan(
            selectedIndices = selected.map { it.index },
            degradedReasonCode = degradedReasonCode,
        )
    }
}
