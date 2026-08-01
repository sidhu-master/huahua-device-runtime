package com.sidhu.device.uiautomationhelper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotWindowPolicyTest {
    @Test
    fun selectsActiveApplicationAndRelevantImeAndOverlayOnly() {
        val plan = SnapshotWindowPolicy.select(
            listOf(
                window(0, SnapshotWindowKind.APPLICATION, active = true),
                window(1, SnapshotWindowKind.APPLICATION),
                window(2, SnapshotWindowKind.INPUT_METHOD, active = true),
                window(3, SnapshotWindowKind.ACCESSIBILITY_OVERLAY, focused = true),
                window(4, SnapshotWindowKind.SYSTEM, active = true),
            ),
        )

        assertEquals(listOf(0, 2, 3), plan.selectedIndices)
        assertNull(plan.degradedReasonCode)
    }

    @Test
    fun missingRelevantInputMethodRootMarksSnapshotDegraded() {
        val plan = SnapshotWindowPolicy.select(
            listOf(
                window(0, SnapshotWindowKind.APPLICATION, active = true),
                window(1, SnapshotWindowKind.INPUT_METHOD, active = true, rootAvailable = false),
            ),
        )

        assertEquals(listOf(0, 1), plan.selectedIndices)
        assertEquals("INPUT_METHOD_WINDOW_ROOT_UNAVAILABLE", plan.degradedReasonCode)
    }

    @Test
    fun missingUnrelatedSystemRootIsIgnored() {
        val plan = SnapshotWindowPolicy.select(
            listOf(
                window(0, SnapshotWindowKind.APPLICATION, active = true),
                window(1, SnapshotWindowKind.SYSTEM, active = true, rootAvailable = false),
            ),
        )

        assertEquals(listOf(0), plan.selectedIndices)
        assertNull(plan.degradedReasonCode)
    }

    private fun window(
        index: Int,
        kind: SnapshotWindowKind,
        active: Boolean = false,
        focused: Boolean = false,
        rootAvailable: Boolean = true,
    ) = SnapshotWindowDescriptor(index, kind, active, focused, rootAvailable)
}
