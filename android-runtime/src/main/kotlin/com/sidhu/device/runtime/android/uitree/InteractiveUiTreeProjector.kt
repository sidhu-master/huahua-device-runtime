package com.sidhu.device.runtime.android.uitree

/** Converts raw UiAutomation nodes into the compact, deterministic action context. */
class InteractiveUiTreeProjector {
    fun project(
        rawNodes: List<RawUiNode>,
        foregroundPackage: String,
        capturedAtMs: Long,
    ): UiTreeCapture {
        val visibleNodes = rawNodes
            .asSequence()
            .filter { it.visibleToUser && it.activeWindow && !it.covered && it.bounds?.isPositive == true }
            .toList()
        val nodesByIndex = visibleNodes.associateBy { it.index }
        val childrenByParent = visibleNodes.groupBy { it.parentIndex }
        val actionableDescendants = HashMap<Int, Boolean>()

        fun hasActionableDescendant(node: RawUiNode): Boolean = actionableDescendants.getOrPut(node.index) {
            childrenByParent[node.index].orEmpty().any { child ->
                isDirectlyActionable(child) || hasActionableDescendant(child)
            }
        }

        fun hasActionableAncestor(node: RawUiNode): Boolean {
            var parent = node.parentIndex?.let(nodesByIndex::get)
            while (parent != null) {
                if (isDirectlyActionable(parent)) return true
                parent = parent.parentIndex?.let(nodesByIndex::get)
            }
            return false
        }

        fun hasCollectionAncestor(node: RawUiNode): Boolean {
            var parent = node.parentIndex?.let(nodesByIndex::get)
            while (true) {
                val current = parent ?: return false
                if (isCollection(current)) return true
                parent = current.parentIndex?.let(nodesByIndex::get)
            }
        }

        val selected = visibleNodes.filter { node ->
            val directlyActionable = isDirectlyActionable(node)
            val hasActionableDescendant = hasActionableDescendant(node)
            val semanticProxy = hasMeaningfulLabel(node) || hasNonGenericIdentifier(node)
            directlyActionable ||
                (node.scrollable && hasActionableDescendant) ||
                (semanticProxy && (
                    hasActionableAncestor(node) ||
                        hasActionableDescendant ||
                        hasCollectionAncestor(node)
                    ))
        }
        val rawNodesByIndex = rawNodes.associateBy { it.index }
        val retainedByIndex = selected.associateBy { it.index }

        fun nearestRetainedParentIndex(node: RawUiNode): Int? {
            var parentIndex = node.parentIndex
            while (parentIndex != null) {
                if (retainedByIndex.containsKey(parentIndex)) return parentIndex
                parentIndex = rawNodesByIndex[parentIndex]?.parentIndex
            }
            return null
        }

        val projectedNodes = selected.map { node ->
            node to nearestRetainedParentIndex(node)
        }
        val parentLabels = projectedNodes
            .mapNotNull { (node, _) -> node.label?.trim()?.takeIf { it.isNotEmpty() }?.let(node.index::to) }
            .toMap()

        return UiTreeCapture(
            status = UiTreeStatus.AVAILABLE,
            nodes = projectedNodes.mapIndexed { position, (node, parentSourceIndex) ->
                val parentLabel = parentSourceIndex?.let(parentLabels::get)
                val label = node.label?.trim()?.takeUnless { it == parentLabel }
                InteractiveUiNode(
                    ref = "e${position + 1}",
                    sourceIndex = node.index,
                    parentSourceIndex = parentSourceIndex,
                    role = node.role,
                    label = label,
                    identifier = node.identifier?.trim()?.ifBlank { null },
                    bounds = checkNotNull(node.bounds),
                    enabled = node.enabled,
                    clickable = node.clickable,
                    selected = node.selected,
                    focused = node.focused,
                    editable = node.editable,
                    scrollable = node.scrollable,
                )
            },
            foregroundPackage = foregroundPackage,
            capturedAtMs = capturedAtMs,
            rawNodeCount = rawNodes.size,
        )
    }

    private fun isDirectlyActionable(node: RawUiNode): Boolean =
        node.focused || (node.enabled && (node.clickable || node.focusable || node.editable))

    private fun hasMeaningfulLabel(node: RawUiNode): Boolean = node.label?.isNotBlank() == true

    /** Matches agent-device: Android resource ids are execution metadata, not semantic labels. */
    private fun hasNonGenericIdentifier(node: RawUiNode): Boolean {
        val identifier = node.identifier?.trim().orEmpty()
        return identifier.isNotEmpty() && !GENERIC_ANDROID_RESOURCE_ID.matches(identifier)
    }

    private fun isCollection(node: RawUiNode): Boolean {
        val role = node.role.lowercase()
        return role.contains("recyclerview") || role.contains("listview") || role.contains("gridview")
    }

    private companion object {
        val GENERIC_ANDROID_RESOURCE_ID = Regex("^[\\w.]+:id/[\\w.-]+$", RegexOption.IGNORE_CASE)
    }
}
