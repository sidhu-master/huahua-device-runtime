package com.sidhu.device.runtime.android.uitree

/** Produces deterministic, reference-independent deltas between semantic snapshots. */
class SemanticUiSnapshotDiffer {
    fun diff(previous: SemanticUiSnapshot?, current: SemanticUiSnapshot): SemanticUiSnapshotDiff {
        val currentRefs = current.lines.mapNotNull { line ->
            line.ref?.let { SemanticUiRef(it, line.sourceIndex, line.parentSourceIndex) }
        }
        if (previous == null) {
            return SemanticUiSnapshotDiff(
                previousSnapshotId = null,
                currentSnapshotId = current.snapshotId,
                added = current.lines,
                removed = emptyList(),
                changed = emptyList(),
                currentRefs = currentRefs,
                pageChanged = current.lines.isNotEmpty(),
                useFullSnapshot = true,
            )
        }

        val previousByLocation = previous.lines.groupBy(::location)
        val currentByLocation = current.lines.groupBy(::location)
        if (previousByLocation.values.any { it.size > 1 } || currentByLocation.values.any { it.size > 1 }) {
            val pageChanged = !sameSemanticLines(previous.lines, current.lines)
            return SemanticUiSnapshotDiff(
                previousSnapshotId = previous.snapshotId,
                currentSnapshotId = current.snapshotId,
                added = if (pageChanged) current.lines else emptyList(),
                removed = if (pageChanged) previous.lines else emptyList(),
                changed = emptyList(),
                currentRefs = currentRefs,
                pageChanged = pageChanged,
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
        val diffCharacterCount = (added + removed + changed).sumOf(SemanticUiSnapshotProjector::serializedCharacterCount) +
            currentRefs.sumOf { it.ref.length + it.sourceIndex.toString().length + (it.parentSourceIndex?.toString()?.length ?: 0) + 2 }
        return SemanticUiSnapshotDiff(
            previousSnapshotId = previous.snapshotId,
            currentSnapshotId = current.snapshotId,
            added = added,
            removed = removed,
            changed = changed,
            currentRefs = currentRefs,
            pageChanged = pageChanged,
            useFullSnapshot = pageChanged && diffCharacterCount >= current.serializedCharacterCount,
        )
    }

    private fun location(line: SemanticUiLine): Pair<Int, Int?> = line.sourceIndex to line.parentSourceIndex

    private fun sameSemanticContent(left: SemanticUiLine, right: SemanticUiLine): Boolean =
        left.copy(ref = null) == right.copy(ref = null)

    private fun sameSemanticLines(left: List<SemanticUiLine>, right: List<SemanticUiLine>): Boolean =
        left.map { it.copy(ref = null) }.groupingBy { it }.eachCount() ==
            right.map { it.copy(ref = null) }.groupingBy { it }.eachCount()
}
