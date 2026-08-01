package com.sidhu.device.runtime.android.uitree

/** Produces deterministic, reference-independent deltas between semantic snapshots. */
class SemanticUiSnapshotDiffer {
    fun diff(previous: SemanticUiSnapshot?, current: SemanticUiSnapshot): SemanticUiSnapshotDiff {
        if (previous == null) {
            return SemanticUiSnapshotDiff(
                previousSnapshotId = null,
                currentSnapshotId = current.snapshotId,
                added = current.lines,
                removed = emptyList(),
                changed = emptyList(),
                pageChanged = current.lines.isNotEmpty(),
                useFullSnapshot = true,
            )
        }

        val previousByLocation = previous.lines.groupBy(::location)
        val currentByLocation = current.lines.groupBy(::location)
        if (previousByLocation.values.any { it.size > 1 } || currentByLocation.values.any { it.size > 1 }) {
            return SemanticUiSnapshotDiff(
                previousSnapshotId = previous.snapshotId,
                currentSnapshotId = current.snapshotId,
                added = current.lines,
                removed = previous.lines,
                changed = emptyList(),
                pageChanged = previous.lines != current.lines,
                useFullSnapshot = true,
            )
        }

        val added = current.lines.filter { location(it) !in previousByLocation }
        val removed = previous.lines.filter { location(it) !in currentByLocation }
        val changed = current.lines.filter { line ->
            previousByLocation[location(line)]?.singleOrNull()?.let { previousLine ->
                !sameSemanticContent(previousLine, line)
            } == true
        }
        val pageChanged = added.isNotEmpty() || removed.isNotEmpty() || changed.isNotEmpty()
        val diffCharacterCount = (added + removed + changed).sumOf(SemanticUiSnapshotProjector::serializedCharacterCount)
        return SemanticUiSnapshotDiff(
            previousSnapshotId = previous.snapshotId,
            currentSnapshotId = current.snapshotId,
            added = added,
            removed = removed,
            changed = changed,
            pageChanged = pageChanged,
            useFullSnapshot = pageChanged && diffCharacterCount >= current.serializedCharacterCount,
        )
    }

    private fun location(line: SemanticUiLine): Pair<Int, Int?> = line.sourceIndex to line.parentSourceIndex

    private fun sameSemanticContent(left: SemanticUiLine, right: SemanticUiLine): Boolean =
        left.copy(ref = null) == right.copy(ref = null)
}
