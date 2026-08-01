package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SemanticUiSnapshotDifferTest {
    @Test
    fun reportsAdditionsRemovalsAndChangedStateWhileIgnoringNewRefs() {
        val previous = snapshot(
            "previous",
            line(ref = "e1", sourceIndex = 1, label = "搜索"),
            line(ref = "e2", sourceIndex = 2, label = "收藏"),
            line(ref = "e3", sourceIndex = 3, label = "设置"),
        )
        val current = snapshot(
            "current",
            line(ref = "e9", sourceIndex = 1, label = "搜索"),
            line(ref = "e8", sourceIndex = 2, role = "textbox", label = "已收藏", selected = true),
            line(ref = "e7", sourceIndex = 4, label = "帮助"),
        )

        val diff = SemanticUiSnapshotDiffer().diff(previous, current)

        assertEquals(listOf("帮助"), diff.added.map { it.label })
        assertEquals(listOf("设置"), diff.removed.map { it.label })
        assertEquals(listOf("已收藏"), diff.changed.map { it.label })
        assertTrue(diff.pageChanged)
        assertTrue(diff.useFullSnapshot)
    }

    @Test
    fun reportsAnEmptyDiffForEquivalentLinesWithReplacementRefs() {
        val previous = snapshot("previous", line(ref = "e1", sourceIndex = 1, label = "搜索"))
        val current = snapshot("current", line(ref = "e9", sourceIndex = 1, label = "搜索"))

        val diff = SemanticUiSnapshotDiffer().diff(previous, current)

        assertTrue(diff.added.isEmpty())
        assertTrue(diff.removed.isEmpty())
        assertTrue(diff.changed.isEmpty())
        assertFalse(diff.pageChanged)
    }

    @Test
    fun requiresFullSnapshotForFirstOrOversizedDiff() {
        val current = snapshot(
            "current",
            line(ref = "e1", sourceIndex = 1, label = "搜索"),
            line(ref = "e2", sourceIndex = 2, label = "设置"),
        )
        val first = SemanticUiSnapshotDiffer().diff(null, current)
        val oversized = SemanticUiSnapshotDiffer().diff(
            snapshot(
                "previous",
                line(ref = "e3", sourceIndex = 3, label = "登录"),
                line(ref = "e4", sourceIndex = 4, label = "注册"),
            ),
            current,
        )

        assertTrue(first.useFullSnapshot)
        assertTrue(oversized.useFullSnapshot)
    }

    @Test
    fun requiresFullSnapshotForAmbiguousLocationsWithoutTreatingReplacementRefsAsAChange() {
        val previous = snapshot(
            "previous",
            line(ref = "e1", sourceIndex = 1, label = "搜索"),
            line(ref = "e2", sourceIndex = 1, label = "搜索"),
        )
        val current = snapshot(
            "current",
            line(ref = "e9", sourceIndex = 1, label = "搜索"),
            line(ref = "e8", sourceIndex = 1, label = "搜索"),
        )

        val diff = SemanticUiSnapshotDiffer().diff(previous, current)

        assertTrue(diff.useFullSnapshot)
        assertFalse(diff.pageChanged)
        assertTrue(diff.added.isEmpty())
        assertTrue(diff.removed.isEmpty())
    }

    @Test
    fun requiresFullSnapshotWhenAmbiguousLocationsHaveSemanticChanges() {
        val previous = snapshot(
            "previous",
            line(ref = "e1", sourceIndex = 1, label = "搜索"),
            line(ref = "e2", sourceIndex = 1, label = "搜索"),
        )
        val current = snapshot(
            "current",
            line(ref = "e9", sourceIndex = 1, label = "搜索"),
            line(ref = "e8", sourceIndex = 1, label = "已搜索", selected = true),
        )

        val diff = SemanticUiSnapshotDiffer().diff(previous, current)

        assertTrue(diff.useFullSnapshot)
        assertTrue(diff.pageChanged)
        assertEquals(listOf("搜索", "已搜索"), diff.added.map { it.label })
        assertEquals(listOf("搜索", "搜索"), diff.removed.map { it.label })
    }

    @Test
    fun keepsASmallerChangedDeltaWhenMeasuredAgainstTheCurrentSnapshot() {
        val previous = snapshot(
            "previous",
            line(ref = "e1", sourceIndex = 1, label = "搜索"),
            line(ref = "e2", sourceIndex = 2, label = "设置"),
            line(ref = "e3", sourceIndex = 3, label = "帮助"),
        )
        val current = snapshot(
            "current",
            line(ref = "e9", sourceIndex = 1, label = "搜索"),
            line(ref = "e8", sourceIndex = 2, label = "已设置", selected = true),
            line(ref = "e7", sourceIndex = 3, label = "帮助"),
        )

        val diff = SemanticUiSnapshotDiffer().diff(previous, current)

        assertEquals(listOf("已设置"), diff.changed.map { it.label })
        assertFalse(diff.useFullSnapshot)
    }

    private fun snapshot(snapshotId: String, vararg lines: SemanticUiLine) = SemanticUiSnapshot(
        snapshotId = snapshotId,
        status = UiTreeStatus.AVAILABLE,
        foregroundPackage = "com.example",
        capturedAtMs = 1L,
        lines = lines.toList(),
        rawNodeCount = lines.size,
        serializedCharacterCount = lines.sumOf(SemanticUiSnapshotProjector::serializedCharacterCount),
    )

    private fun line(
        ref: String,
        sourceIndex: Int,
        label: String,
        role: String = "button",
        selected: Boolean = false,
    ) = SemanticUiLine(
        ref = ref,
        sourceIndex = sourceIndex,
        parentSourceIndex = null,
        depth = 0,
        role = role,
        label = label,
        selected = selected,
    )
}
