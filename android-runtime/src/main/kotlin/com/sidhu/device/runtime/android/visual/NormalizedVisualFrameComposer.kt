package com.sidhu.device.runtime.android.visual

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect

/**
 * Builds the exact visual frame shown to an agent.  Both the built-in worker and
 * LAN MCP use this composer, so a coordinate always refers to the same pixels.
 */
data class NormalizedVisualFrame(
    val bitmap: Bitmap,
    val layout: NormalizedVisualLayout,
)

object NormalizedVisualFrameComposer {
    fun compose(
        current: Bitmap,
        previous: Bitmap?,
        screenWidth: Int,
        screenHeight: Int,
    ): NormalizedVisualFrame {
        require(!current.isRecycled && current.width > 0 && current.height > 0) {
            "current screenshot must be usable"
        }
        val resolvedWidth = screenWidth.takeIf { it > 0 } ?: current.width
        val resolvedHeight = screenHeight.takeIf { it > 0 } ?: current.height
        if (previous == null || previous.isRecycled || previous.width <= 0 || previous.height <= 0) {
            return NormalizedVisualFrame(
                bitmap = current,
                layout = NormalizedVisualLayout.single(resolvedWidth, resolvedHeight),
            )
        }

        val panelWidth = current.width
        val panelHeight = current.height
        val stitched = Bitmap.createBitmap(panelWidth * 2, panelHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(stitched)
        canvas.drawColor(Color.BLACK)
        val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(previous, null, Rect(0, 0, panelWidth, panelHeight), imagePaint)
        canvas.drawBitmap(current, null, Rect(panelWidth, 0, panelWidth * 2, panelHeight), imagePaint)
        drawPanelLabel(canvas, "BEFORE", 18, 18)
        drawPanelLabel(canvas, "CURRENT", panelWidth + 18, 18)
        return NormalizedVisualFrame(
            bitmap = stitched,
            layout = NormalizedVisualLayout.beforeCurrent(resolvedWidth, resolvedHeight),
        )
    }

    private fun drawPanelLabel(canvas: Canvas, label: String, x: Int, y: Int) {
        val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = 34f
        }
        val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(170, 0, 0, 0)
        }
        val paddingX = 14
        val paddingY = 10
        val bounds = Rect()
        textPaint.getTextBounds(label, 0, label.length, bounds)
        canvas.drawRect(
            Rect(x - paddingX, y - paddingY, x + bounds.width() + paddingX, y + bounds.height() + paddingY * 2),
            backgroundPaint,
        )
        canvas.drawText(label, x.toFloat(), (y + bounds.height()).toFloat(), textPaint)
    }
}
