package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SemanticUiObservationPipelineTest {
    @Test
    fun differFailureFallsBackToFullCurrentSemanticSnapshotWithSeparateDurations() {
        val times = sequenceOf(0L, 2_000_000L, 2_000_000L, 7_000_000L).iterator()
        val pipeline = SemanticUiObservationPipeline(
            projector = { SemanticUiSnapshotProjector().project(it) },
            differ = { _, _ -> error("diff failed") },
            nanoTime = times::next,
        )

        val result = pipeline.observe(capture())

        assertNotNull(result.fullLines)
        assertNull(result.diff)
        assertEquals("SEMANTIC_DIFF_FAILED", result.fallbackReasonCode)
        assertEquals(2L, result.projectionDurationMs)
        assertEquals(5L, result.diffDurationMs)
    }

    @Test
    fun projectorFailureReturnsDegradedVisualFallbackWithoutThrowing() {
        val pipeline = SemanticUiObservationPipeline(projector = { error("projection failed") })

        val result = pipeline.observe(capture())

        assertEquals(UiTreeStatus.DEGRADED, result.snapshot.status)
        assertEquals("SEMANTIC_PROJECTION_FAILED", result.snapshot.reasonCode)
        assertEquals("SEMANTIC_PROJECTION_FAILED", result.fallbackReasonCode)
        assertTrue(result.fullLines.orEmpty().isEmpty())
    }

    private fun capture() = UiTreeCapture(
        status = UiTreeStatus.AVAILABLE,
        nodes = listOf(
            InteractiveUiNode("e1@current", 1, null, "android.widget.Button", "提交", null, UiTreeBounds(0, 0, 100, 50), true, true, false, false),
        ),
        foregroundPackage = "com.example",
        capturedAtMs = 1L,
    )
}
