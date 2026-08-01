package com.sidhu.device.runtime.android.uitree

enum class UiTreeStatus {
    AVAILABLE,
    DEGRADED,
    UNAVAILABLE,
}

data class UiTreeBounds(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
) {
    val isPositive: Boolean get() = width > 0 && height > 0
}

data class RawUiNode(
    val index: Int,
    val parentIndex: Int? = null,
    val role: String,
    val label: String? = null,
    val identifier: String? = null,
    val bounds: UiTreeBounds?,
    val visibleToUser: Boolean = true,
    val enabled: Boolean = true,
    val clickable: Boolean = false,
    val focusable: Boolean = false,
    val focused: Boolean = false,
    val selected: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val activeWindow: Boolean = true,
    val covered: Boolean = false,
)
data class InteractiveUiNode(
    val ref: String,
    val sourceIndex: Int,
    val parentSourceIndex: Int?,
    val role: String,
    val label: String?,
    val identifier: String?,
    val bounds: UiTreeBounds,
    val enabled: Boolean,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val focusable: Boolean = false,
    val selected: Boolean = false,
    val focused: Boolean = false,
)

data class UiTreeCapture(
    val status: UiTreeStatus,
    val nodes: List<InteractiveUiNode>,
    val foregroundPackage: String,
    val capturedAtMs: Long,
    val rawNodeCount: Int = nodes.size,
    val reasonCode: String? = null,
    val captureScopeId: String = "$foregroundPackage:$capturedAtMs",
)

data class SemanticUiLine(
    val ref: String?,
    val sourceIndex: Int,
    val parentSourceIndex: Int?,
    val depth: Int,
    val role: String,
    val label: String?,
    val disabled: Boolean = false,
    val selected: Boolean = false,
    val focused: Boolean = false,
    val editable: Boolean = false,
    val scrollable: Boolean = false,
    val truncated: Boolean = false,
)

data class SemanticUiSnapshot(
    val snapshotId: String,
    val status: UiTreeStatus,
    val foregroundPackage: String,
    val capturedAtMs: Long,
    val lines: List<SemanticUiLine>,
    val rawNodeCount: Int,
    val serializedCharacterCount: Int,
    val reasonCode: String? = null,
)

data class SemanticUiSnapshotDiff(
    val previousSnapshotId: String?,
    val currentSnapshotId: String,
    val added: List<SemanticUiLine>,
    val removed: List<SemanticUiLine>,
    val changed: List<SemanticUiLine>,
    val currentRefs: List<SemanticUiRef>,
    val pageChanged: Boolean,
    val useFullSnapshot: Boolean,
)

/** Complete current-snapshot ref mapping carried by every compact diff. */
data class SemanticUiRef(
    val ref: String,
    val sourceIndex: Int,
    val parentSourceIndex: Int?,
)
