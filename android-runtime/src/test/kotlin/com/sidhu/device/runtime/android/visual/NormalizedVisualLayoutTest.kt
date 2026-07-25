package com.sidhu.device.runtime.android.visual

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NormalizedVisualLayoutTest {
    @Test
    fun singlePanelMapsNormalizedPointToPhysicalScreen() {
        val layout = NormalizedVisualLayout.single(screenWidth = 1440, screenHeight = 3120)

        assertEquals(ScreenPoint(720, 1560), layout.mapCurrentPoint(500, 500))
    }

    @Test
    fun beforeCurrentMapsOnlyRightPanelToPhysicalScreen() {
        val layout = NormalizedVisualLayout.beforeCurrent(screenWidth = 1440, screenHeight = 3120)

        assertEquals(ScreenPoint(720, 1560), layout.mapCurrentPoint(750, 500))
        assertNull(layout.mapCurrentPoint(250, 500))
    }

    @Test
    fun normalizesRawCurrentBoundsIntoCurrentPanel() {
        val layout = NormalizedVisualLayout.beforeCurrent(screenWidth = 1440, screenHeight = 3120)

        assertEquals(
            NormalizedBounds(x = 750, y = 250, width = 100, height = 250),
            layout.normalizeCurrentBounds(ScreenBounds(x = 720, y = 780, width = 288, height = 780)),
        )
    }

    @Test
    fun beforeCurrentPreservesRenderedVisualPixelPrecision() {
        val layout = NormalizedVisualLayout.beforeCurrent(screenWidth = 1440, screenHeight = 3120)

        assertEquals(ScreenPoint(720, 2400), layout.mapCurrentVisualPixel(2160, 2400, 2880, 3120))
    }
}
