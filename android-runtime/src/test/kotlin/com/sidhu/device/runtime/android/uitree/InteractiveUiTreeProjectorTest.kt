package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractiveUiTreeProjectorTest {
    @Test
    fun projectsVisibleActionableCardAndItsMeaningfulText() {
        val result = InteractiveUiTreeProjector(captureScopeIdFactory = { "capture-a" }).project(
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
        assertEquals(listOf("e1@capture-a", "e2@capture-a", "e3@capture-a", "e4@capture-a"), result.nodes.map { it.ref })
    }

    @Test
    fun scopesEveryExecutionReferenceToItsCapture() {
        val projector = InteractiveUiTreeProjector(
            captureScopeIdFactory = sequenceOf("capture-a", "capture-b").iterator()::next,
        )
        val nodes = listOf(
            RawUiNode(
                index = 0,
                role = "android.widget.Button",
                label = "提交",
                bounds = UiTreeBounds(0, 0, 180, 64),
                clickable = true,
            ),
        )

        val first = projector.project(nodes, "com.example", 1L)
        val second = projector.project(nodes, "com.example", 2L)

        assertEquals("capture-a", first.captureScopeId)
        assertEquals("capture-b", second.captureScopeId)
        assertEquals("e1@capture-a", first.nodes.single().ref)
        assertEquals("e1@capture-b", second.nodes.single().ref)
        assertFalse(second.nodes.any { it.ref == first.nodes.single().ref })
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

    @Test
    fun repairsMeaningfulDescendantParentToNearestRetainedAncestorAndCarriesState() {
        val result = InteractiveUiTreeProjector().project(
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
                    label = "订单",
                    bounds = UiTreeBounds(0, 0, 1080, 180),
                    clickable = true,
                    selected = true,
                    focused = true,
                ),
                RawUiNode(
                    index = 2,
                    parentIndex = 1,
                    role = "android.widget.LinearLayout",
                    bounds = UiTreeBounds(0, 0, 1000, 140),
                ),
                RawUiNode(
                    index = 3,
                    parentIndex = 2,
                    role = "android.widget.TextView",
                    label = "待付款",
                    bounds = UiTreeBounds(40, 20, 400, 56),
                ),
            ),
            foregroundPackage = "com.example",
            capturedAtMs = 1L,
        )

        assertEquals(listOf(null, 1), result.nodes.map { it.parentSourceIndex })
        assertTrue(result.nodes.first { it.sourceIndex == 1 }.selected)
        assertTrue(result.nodes.first { it.sourceIndex == 1 }.focused)
    }
}
