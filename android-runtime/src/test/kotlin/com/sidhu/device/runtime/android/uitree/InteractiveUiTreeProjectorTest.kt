package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractiveUiTreeProjectorTest {
    @Test
    fun projectsVisibleActionableCardAndItsMeaningfulText() {
        val result = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 0,
                    role = "androidx.recyclerview.widget.RecyclerView",
                    bounds = UiTreeBounds(0, 100, 1080, 1600),
                    visibleToUser = true,
                    scrollable = true,
                ),
                RawUiNode(
                    index = 1,
                    parentIndex = 0,
                    role = "android.widget.LinearLayout",
                    bounds = UiTreeBounds(0, 160, 1080, 420),
                    visibleToUser = true,
                    clickable = true,
                ),
                RawUiNode(
                    index = 2,
                    parentIndex = 1,
                    role = "android.widget.TextView",
                    label = "商品甲",
                    bounds = UiTreeBounds(40, 180, 400, 56),
                    visibleToUser = true,
                ),
                RawUiNode(
                    index = 3,
                    parentIndex = 1,
                    role = "android.widget.TextView",
                    label = "¥129",
                    bounds = UiTreeBounds(40, 250, 240, 56),
                    visibleToUser = true,
                ),
                RawUiNode(
                    index = 4,
                    role = "android.widget.TextView",
                    label = "隐藏内容",
                    bounds = UiTreeBounds(0, 0, 200, 30),
                    visibleToUser = false,
                ),
            ),
            foregroundPackage = "com.example.store",
            capturedAtMs = 1234L,
        )

        assertEquals(UiTreeStatus.AVAILABLE, result.status)
        assertEquals(listOf("商品甲", "¥129"), result.nodes.mapNotNull { it.label })
        assertTrue(result.nodes.any { it.clickable })
        assertFalse(result.nodes.any { it.label == "隐藏内容" })
        assertEquals(listOf("e1", "e2", "e3", "e4"), result.nodes.map { it.ref })
    }

    @Test
    fun keepsVisibleTextWithoutKeywordRedaction() {
        val result = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 0,
                    role = "android.widget.Button",
                    label = "验证码 123456",
                    bounds = UiTreeBounds(0, 0, 180, 64),
                    visibleToUser = true,
                    clickable = true,
                ),
            ),
            foregroundPackage = "com.example",
            capturedAtMs = 1L,
        )

        assertEquals("验证码 123456", result.nodes.single().label)
    }

    @Test
    fun omitsGenericIdOnlyLayoutWhenItsActionableChildIsAlreadyVisible() {
        val result = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 0,
                    role = "android.widget.FrameLayout",
                    identifier = "com.example:id/content",
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
            ),
            foregroundPackage = "com.example",
            capturedAtMs = 1L,
        )

        assertEquals(listOf(1), result.nodes.map { it.sourceIndex })
        assertEquals("提交", result.nodes.single().label)
    }

    @Test
    fun omitsScrollableContainerWithoutActionableDescendantButKeepsCollectionText() {
        val result = InteractiveUiTreeProjector().project(
            rawNodes = listOf(
                RawUiNode(
                    index = 0,
                    role = "androidx.recyclerview.widget.RecyclerView",
                    bounds = UiTreeBounds(0, 0, 1080, 1600),
                    scrollable = true,
                ),
                RawUiNode(
                    index = 1,
                    parentIndex = 0,
                    role = "android.widget.TextView",
                    label = "正在加载",
                    bounds = UiTreeBounds(40, 80, 220, 60),
                ),
            ),
            foregroundPackage = "com.example",
            capturedAtMs = 1L,
        )

        assertEquals(listOf(1), result.nodes.map { it.sourceIndex })
        assertEquals("正在加载", result.nodes.single().label)
    }
}
