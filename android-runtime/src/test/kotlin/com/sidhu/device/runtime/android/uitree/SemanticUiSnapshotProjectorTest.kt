package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SemanticUiSnapshotProjectorTest {
    @Test
    fun projectsPlatformNeutralLinesWithoutEmptyLayoutsOrGenericIdentifiers() {
        val capture = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 0,
                    role = "android.widget.LinearLayout",
                    bounds = UiTreeBounds(0, 0, 1080, 480),
                ),
                RawUiNode(
                    index = 1,
                    parentIndex = 0,
                    role = "android.widget.Button",
                    label = "提交",
                    identifier = "com.example:id/submit",
                    bounds = UiTreeBounds(40, 320, 220, 80),
                    clickable = true,
                ),
                RawUiNode(
                    index = 2,
                    parentIndex = 1,
                    role = "android.widget.LinearLayout",
                    bounds = UiTreeBounds(40, 20, 160, 60),
                ),
                RawUiNode(
                    index = 3,
                    parentIndex = 2,
                    role = "android.widget.TextView",
                    label = "提交",
                    bounds = UiTreeBounds(40, 20, 160, 60),
                ),
            ),
            foregroundPackage = "com.example.store",
            capturedAtMs = 42L,
        )

        val snapshot = SemanticUiSnapshotProjector().project(capture)

        assertEquals("com.example.store:42", snapshot.snapshotId)
        assertEquals(listOf("button", "text"), snapshot.lines.map { it.role })
        assertEquals(listOf("提交", null), snapshot.lines.map { it.label })
        assertEquals(listOf(0, 1), snapshot.lines.map { it.depth })
        assertFalse(snapshot.lines.any { it.role == "layout" })
    }

    @Test
    fun preservesUnlabelledControlsAndOnlyShowsNonDefaultState() {
        val capture = UiTreeCapture(
            status = UiTreeStatus.AVAILABLE,
            foregroundPackage = "com.example",
            capturedAtMs = 7L,
            nodes = listOf(
                node(ref = "e1", sourceIndex = 1, role = "android.widget.Button"),
                node(
                    ref = "e2",
                    sourceIndex = 2,
                    role = "android.widget.EditText",
                    enabled = false,
                    selected = true,
                    focused = true,
                    editable = true,
                    scrollable = true,
                ),
            ),
        )

        val lines = SemanticUiSnapshotProjector().project(capture).lines

        assertEquals("e1", lines[0].ref)
        assertNull(lines[0].label)
        assertFalse(lines[0].disabled)
        assertFalse(lines[0].selected)
        assertFalse(lines[0].focused)
        assertFalse(lines[0].editable)
        assertFalse(lines[0].scrollable)
        assertTrue(lines[1].disabled)
        assertTrue(lines[1].selected)
        assertTrue(lines[1].focused)
        assertTrue(lines[1].editable)
        assertTrue(lines[1].scrollable)
    }

    @Test
    fun truncatesChineseLabelsAtConfiguredPreviewLimitWithoutDroppingActionReference() {
        val capture = UiTreeCapture(
            status = UiTreeStatus.AVAILABLE,
            foregroundPackage = "com.example",
            capturedAtMs = 7L,
            nodes = listOf(node(ref = "e9", sourceIndex = 9, role = "android.widget.Button", label = "这是一个很长的中文标签")),
        )

        val line = SemanticUiSnapshotProjector(labelPreviewLimit = 5).project(capture).lines.single()

        assertEquals("这是一个很", line.label)
        assertTrue(line.truncated)
        assertEquals("e9", line.ref)
    }

    @Test
    fun retainsUnlabelledFocusableGenericControlsWithTheirInteractiveReference() {
        val capture = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 4,
                    role = "android.view.View",
                    identifier = "com.example:id/generic_control",
                    bounds = UiTreeBounds(0, 0, 100, 100),
                    focusable = true,
                ),
            ),
            foregroundPackage = "com.example",
            capturedAtMs = 8L,
        )

        val line = SemanticUiSnapshotProjector().project(capture).lines.single()

        assertEquals(capture.nodes.single().ref, line.ref)
        assertEquals("group", line.role)
        assertNull(line.label)
    }

    private fun node(
        ref: String,
        sourceIndex: Int,
        role: String,
        label: String? = null,
        parentSourceIndex: Int? = null,
        enabled: Boolean = true,
        selected: Boolean = false,
        focused: Boolean = false,
        editable: Boolean = false,
        scrollable: Boolean = false,
    ) = InteractiveUiNode(
        ref = ref,
        sourceIndex = sourceIndex,
        parentSourceIndex = parentSourceIndex,
        role = role,
        label = label,
        identifier = "com.example:id/generic",
        bounds = UiTreeBounds(0, 0, 1, 1),
        enabled = enabled,
        clickable = true,
        editable = editable,
        scrollable = scrollable,
        selected = selected,
        focused = focused,
    )
}
