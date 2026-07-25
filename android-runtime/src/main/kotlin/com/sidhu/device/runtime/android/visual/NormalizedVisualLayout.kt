package com.sidhu.device.runtime.android.visual

import kotlin.math.roundToInt

/** A raw physical point used only after an agent-facing normalized point is validated. */
data class ScreenPoint(val x: Int, val y: Int)

data class ScreenBounds(val x: Int, val y: Int, val width: Int, val height: Int)

/** Bounds expressed in the same 0–1000 visual space that an agent sees. */
data class NormalizedBounds(val x: Int, val y: Int, val width: Int, val height: Int)

/**
 * Shared visual-coordinate contract for HuAHua's in-app and LAN agents.
 *
 * A single frame makes the complete image actionable. A comparison frame is
 * left BEFORE/right CURRENT and deliberately rejects actions on BEFORE.
 */
class NormalizedVisualLayout private constructor(
    val kind: Kind,
    private val screenWidth: Int,
    private val screenHeight: Int,
) {
    enum class Kind { SINGLE, BEFORE_CURRENT }

    fun mapCurrentPoint(x: Int, y: Int): ScreenPoint? {
        if (x !in NORMALIZED_RANGE || y !in NORMALIZED_RANGE) return null
        val currentX = when (kind) {
            Kind.SINGLE -> x.toDouble() / NORMALIZED_MAX
            Kind.BEFORE_CURRENT -> {
                if (x < NORMALIZED_MAX / 2) return null
                (x - NORMALIZED_MAX / 2).toDouble() / (NORMALIZED_MAX / 2)
            }
        }
        return ScreenPoint(
            x = (currentX * screenWidth).roundToInt().coerceIn(0, screenWidth - 1),
            y = (y.toDouble() / NORMALIZED_MAX * screenHeight).roundToInt().coerceIn(0, screenHeight - 1),
        )
    }

    /**
     * Adapter for an already-rendered visual bitmap. It keeps the built-in
     * worker's pixel precision while sharing the same CURRENT-panel policy.
     */
    fun mapCurrentVisualPixel(x: Int, y: Int, visualWidth: Int, visualHeight: Int): ScreenPoint? {
        if (visualWidth <= 0 || visualHeight <= 0 || x !in 0..visualWidth || y !in 0..visualHeight) return null
        val currentX = when (kind) {
            Kind.SINGLE -> x.toDouble() / visualWidth
            Kind.BEFORE_CURRENT -> {
                val currentPanelLeft = visualWidth / 2.0
                if (x < currentPanelLeft) return null
                (x - currentPanelLeft) / currentPanelLeft
            }
        }
        return ScreenPoint(
            x = (currentX * screenWidth).roundToInt().coerceIn(0, screenWidth - 1),
            y = (y.toDouble() / visualHeight * screenHeight).roundToInt().coerceIn(0, screenHeight - 1),
        )
    }

    fun normalizeCurrentBounds(bounds: ScreenBounds): NormalizedBounds {
        val clampedX = bounds.x.coerceIn(0, screenWidth)
        val clampedY = bounds.y.coerceIn(0, screenHeight)
        val clampedWidth = bounds.width.coerceAtLeast(0).coerceAtMost(screenWidth - clampedX)
        val clampedHeight = bounds.height.coerceAtLeast(0).coerceAtMost(screenHeight - clampedY)
        val scaleX = when (kind) {
            Kind.SINGLE -> NORMALIZED_MAX.toDouble() / screenWidth
            Kind.BEFORE_CURRENT -> (NORMALIZED_MAX / 2).toDouble() / screenWidth
        }
        val offsetX = if (kind == Kind.BEFORE_CURRENT) NORMALIZED_MAX / 2 else 0
        return NormalizedBounds(
            x = (clampedX * scaleX).roundToInt() + offsetX,
            y = (clampedY.toDouble() / screenHeight * NORMALIZED_MAX).roundToInt(),
            width = (clampedWidth * scaleX).roundToInt(),
            height = (clampedHeight.toDouble() / screenHeight * NORMALIZED_MAX).roundToInt(),
        )
    }

    companion object {
        const val NORMALIZED_MAX = 1000
        private val NORMALIZED_RANGE = 0..NORMALIZED_MAX

        fun single(screenWidth: Int, screenHeight: Int): NormalizedVisualLayout =
            create(Kind.SINGLE, screenWidth, screenHeight)

        fun beforeCurrent(screenWidth: Int, screenHeight: Int): NormalizedVisualLayout =
            create(Kind.BEFORE_CURRENT, screenWidth, screenHeight)

        private fun create(kind: Kind, screenWidth: Int, screenHeight: Int): NormalizedVisualLayout {
            require(screenWidth > 0 && screenHeight > 0) { "screen dimensions must be positive" }
            return NormalizedVisualLayout(kind, screenWidth, screenHeight)
        }
    }
}
