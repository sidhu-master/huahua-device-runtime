package com.sidhu.device.runtime.android.uitree

/**
 * Owns one consumer's semantic baseline and contains projection/diff failures at the shared
 * runtime boundary. Raw execution nodes remain available to the caller when this representation
 * is degraded.
 */
class SemanticUiObservationPipeline(
    private val projector: (UiTreeCapture) -> SemanticUiSnapshot = SemanticUiSnapshotProjector()::project,
    private val differ: (SemanticUiSnapshot?, SemanticUiSnapshot) -> SemanticUiSnapshotDiff =
        SemanticUiSnapshotDiffer()::diff,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    private var previousSnapshot: SemanticUiSnapshot? = null

    fun observe(capture: UiTreeCapture): SemanticUiObservationResult {
        val projectionStartedAt = nanoTime()
        val snapshot = try {
            projector(capture)
        } catch (_: Exception) {
            val projectionDurationMs = elapsedMillis(projectionStartedAt, nanoTime())
            previousSnapshot = null
            val degradedSnapshot = SemanticUiSnapshot(
                snapshotId = "${capture.foregroundPackage}:${capture.capturedAtMs}",
                status = UiTreeStatus.DEGRADED,
                foregroundPackage = capture.foregroundPackage,
                capturedAtMs = capture.capturedAtMs,
                lines = emptyList(),
                rawNodeCount = capture.rawNodeCount,
                serializedCharacterCount = 0,
                reasonCode = REASON_PROJECTION_FAILED,
            )
            return SemanticUiObservationResult(
                snapshot = degradedSnapshot,
                fullLines = emptyList(),
                diff = null,
                baselineSnapshot = null,
                projectionDurationMs = projectionDurationMs,
                diffDurationMs = 0,
                fallbackReasonCode = REASON_PROJECTION_FAILED,
            )
        }
        val projectionDurationMs = elapsedMillis(projectionStartedAt, nanoTime())
        val baselineSnapshot = previousSnapshot
        val diffStartedAt = nanoTime()
        val diff = try {
            differ(baselineSnapshot, snapshot)
        } catch (_: Exception) {
            val diffDurationMs = elapsedMillis(diffStartedAt, nanoTime())
            previousSnapshot = snapshot
            return SemanticUiObservationResult(
                snapshot = snapshot,
                fullLines = snapshot.lines,
                diff = null,
                baselineSnapshot = null,
                projectionDurationMs = projectionDurationMs,
                diffDurationMs = diffDurationMs,
                fallbackReasonCode = REASON_DIFF_FAILED,
            )
        }
        val diffDurationMs = elapsedMillis(diffStartedAt, nanoTime())
        previousSnapshot = snapshot
        return if (diff.useFullSnapshot) {
            SemanticUiObservationResult(
                snapshot = snapshot,
                fullLines = snapshot.lines,
                diff = null,
                baselineSnapshot = null,
                projectionDurationMs = projectionDurationMs,
                diffDurationMs = diffDurationMs,
            )
        } else {
            SemanticUiObservationResult(
                snapshot = snapshot,
                fullLines = null,
                diff = diff,
                baselineSnapshot = baselineSnapshot,
                projectionDurationMs = projectionDurationMs,
                diffDurationMs = diffDurationMs,
            )
        }
    }

    fun reset() {
        previousSnapshot = null
    }

    private fun elapsedMillis(startedAt: Long, endedAt: Long): Long =
        (endedAt - startedAt).coerceAtLeast(0L) / 1_000_000

    companion object {
        const val REASON_PROJECTION_FAILED = "SEMANTIC_PROJECTION_FAILED"
        const val REASON_DIFF_FAILED = "SEMANTIC_DIFF_FAILED"
    }
}

data class SemanticUiObservationResult(
    val snapshot: SemanticUiSnapshot,
    val fullLines: List<SemanticUiLine>?,
    val diff: SemanticUiSnapshotDiff?,
    val baselineSnapshot: SemanticUiSnapshot?,
    val projectionDurationMs: Long,
    val diffDurationMs: Long,
    val fallbackReasonCode: String? = null,
) {
    val isFullSnapshot: Boolean get() = fullLines != null
}
