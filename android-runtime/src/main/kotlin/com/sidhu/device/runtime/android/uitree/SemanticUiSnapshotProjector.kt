package com.sidhu.device.runtime.android.uitree

/** Projects execution-oriented UI nodes into a compact, platform-neutral observation. */
class SemanticUiSnapshotProjector(
    private val labelPreviewLimit: Int = DEFAULT_LABEL_PREVIEW_LIMIT,
) {
    init {
        require(labelPreviewLimit > 0) { "labelPreviewLimit must be positive" }
    }

    fun project(capture: UiTreeCapture): SemanticUiSnapshot {
        val retainedNodes = capture.nodes.filterNot(::isEmptyLayout)
        val retainedBySourceIndex = retainedNodes.associateBy { it.sourceIndex }
        val lines = retainedNodes.map { node ->
            val parentSourceIndex = nearestRetainedParent(node.parentSourceIndex, capture.nodes, retainedBySourceIndex)
            val depth = depthOf(parentSourceIndex, capture.nodes, retainedBySourceIndex)
            val rawLabel = node.label?.trim()?.takeIf { it.isNotEmpty() }
            val parentLabel = parentSourceIndex?.let(retainedBySourceIndex::get)?.label?.trim()
            val displayLabel = rawLabel?.takeUnless { it == parentLabel }
            val truncated = displayLabel != null && displayLabel.length > labelPreviewLimit
            SemanticUiLine(
                ref = node.ref,
                sourceIndex = node.sourceIndex,
                parentSourceIndex = parentSourceIndex,
                depth = depth,
                role = normalizeRole(node.role),
                label = displayLabel?.take(labelPreviewLimit),
                disabled = !node.enabled,
                selected = node.selected,
                focused = node.focused,
                editable = node.editable,
                scrollable = node.scrollable,
                truncated = truncated,
            )
        }
        return SemanticUiSnapshot(
            snapshotId = "${capture.foregroundPackage}:${capture.capturedAtMs}",
            status = capture.status,
            foregroundPackage = capture.foregroundPackage,
            capturedAtMs = capture.capturedAtMs,
            lines = lines,
            rawNodeCount = capture.rawNodeCount,
            serializedCharacterCount = lines.sumOf(::serializedCharacterCount),
            reasonCode = capture.reasonCode,
        )
    }

    private fun isEmptyLayout(node: InteractiveUiNode): Boolean =
        normalizeRole(node.role) == "group" &&
            node.label.isNullOrBlank() &&
            node.enabled &&
            !node.clickable &&
            !node.selected &&
            !node.focused &&
            !node.editable &&
            !node.scrollable

    private fun nearestRetainedParent(
        parentSourceIndex: Int?,
        allNodes: List<InteractiveUiNode>,
        retainedNodes: Map<Int, InteractiveUiNode>,
    ): Int? {
        val allNodesBySourceIndex = allNodes.associateBy { it.sourceIndex }
        var current = parentSourceIndex
        while (current != null) {
            if (retainedNodes.containsKey(current)) return current
            current = allNodesBySourceIndex[current]?.parentSourceIndex
        }
        return null
    }

    private fun depthOf(
        parentSourceIndex: Int?,
        allNodes: List<InteractiveUiNode>,
        retainedNodes: Map<Int, InteractiveUiNode>,
    ): Int {
        var depth = 0
        var parent = parentSourceIndex
        while (parent != null) {
            depth += 1
            parent = nearestRetainedParent(retainedNodes[parent]?.parentSourceIndex, allNodes, retainedNodes)
        }
        return depth
    }

    companion object {
        const val DEFAULT_LABEL_PREVIEW_LIMIT = 80

        fun normalizeRole(rawRole: String): String {
            val role = rawRole.lowercase()
            return when {
                role.contains("imagebutton") -> "button"
                role.contains("button") -> "button"
                role.contains("edittext") -> "textbox"
                role.contains("checkbox") -> "checkbox"
                role.contains("radiobutton") -> "radio"
                role.contains("switch") -> "switch"
                role.contains("seekbar") -> "slider"
                role.contains("recyclerview") || role.contains("listview") || role.contains("gridview") -> "list"
                role.contains("imageview") -> "image"
                role.contains("textview") -> "text"
                role.contains("webview") -> "web"
                else -> "group"
            }
        }

        internal fun serializedCharacterCount(line: SemanticUiLine): Int =
            listOf(
                line.ref.orEmpty(),
                line.sourceIndex.toString(),
                line.parentSourceIndex?.toString().orEmpty(),
                line.depth.toString(),
                line.role,
                line.label.orEmpty(),
                line.disabled.toString(),
                line.selected.toString(),
                line.focused.toString(),
                line.editable.toString(),
                line.scrollable.toString(),
                line.truncated.toString(),
            ).sumOf(String::length) + 11
    }
}
