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
                isActionable(child) || hasActionableDescendant(child)
            }
        }

        fun hasActionableAncestor(node: RawUiNode): Boolean {
            var parent = node.parentIndex?.let(nodesByIndex::get)
            while (parent != null) {
                if (isActionable(parent)) return true
                parent = parent.parentIndex?.let(nodesByIndex::get)
            }
            return false
        }

        val selected = visibleNodes.filter { node ->
            val actionable = isActionable(node)
            val meaningfulText = node.label?.isNotBlank() == true || node.identifier?.isNotBlank() == true
            actionable ||
                (meaningfulText && (hasActionableAncestor(node) || hasActionableDescendant(node))) ||
                (isCollection(node) && hasActionableDescendant(node))
        }

        val parentLabels = selected
            .filter { it.label?.isNotBlank() == true }
            .associate { it.index to it.label!!.trim() }

        return UiTreeCapture(
            status = UiTreeStatus.AVAILABLE,
            nodes = selected.mapIndexed { position, node ->
                val parentLabel = node.parentIndex?.let(parentLabels::get)
                val label = node.label?.trim()?.takeUnless { it == parentLabel }
                InteractiveUiNode(
                    ref = "e${position + 1}",
                    sourceIndex = node.index,
                    parentSourceIndex = node.parentIndex,
                    role = node.role,
                    label = label,
                    identifier = node.identifier?.trim()?.ifBlank { null },
                    bounds = checkNotNull(node.bounds),
                    enabled = node.enabled,
                    clickable = node.clickable,
                    editable = node.editable,
                    scrollable = node.scrollable,
                )
            },
            foregroundPackage = foregroundPackage,
            capturedAtMs = capturedAtMs,
        )
    }

    private fun isActionable(node: RawUiNode): Boolean =
        node.enabled && (node.clickable || node.focusable || node.focused || node.editable || node.scrollable)

    private fun isCollection(node: RawUiNode): Boolean {
        val role = node.role.lowercase()
        return role.contains("recyclerview") || role.contains("listview") || role.contains("gridview")
    }
}
