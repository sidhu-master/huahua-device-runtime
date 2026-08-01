package com.sidhu.device.runtime.android.uitree

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiAutomationHelperClientTest {
    @Test
    fun parsesInteractiveSnapshotReturnedByHelper() {
        val response = UiAutomationHelperClient.parseSnapshot(
            """
            {
              "foreground_package":"com.example.store",
              "captured_at_ms":42,
              "nodes":[{
                "index":3,"parent_index":null,"role":"android.widget.Button",
                "label":"搜索","identifier":"com.example:id/search",
                "bounds":{"x":10,"y":20,"width":180,"height":64},
                "visible_to_user":true,"enabled":true,"clickable":true,
                "focused":true,"selected":true
              }]
            }
            """.trimIndent(),
        )

        assertEquals("com.example.store", response.foregroundPackage)
        assertEquals(42L, response.capturedAtMs)
        assertEquals("搜索", response.nodes.single().label)
        assertTrue(response.nodes.single().clickable)
        assertTrue(response.nodes.single().focused)
        assertTrue(response.nodes.single().selected)
    }

    @Test
    fun reportsProtocolErrorWithoutIncludingSnapshotContent() {
        val result = UiAutomationHelperClient.protocolFailure(503)

        assertEquals(UiTreeStatus.DEGRADED, result.status)
        assertEquals("HELPER_HTTP_503", result.reasonCode)
        assertTrue(result.nodes.isEmpty())
    }

    @Test
    fun parsesHelperDegradedStatusAndMachineReason() {
        val response = UiAutomationHelperClient.parseSnapshot(
            """{"foreground_package":"com.example","captured_at_ms":42,"status":"degraded","reason_code":"INPUT_METHOD_WINDOW_ROOT_UNAVAILABLE","nodes":[]}""",
        )

        assertEquals(UiTreeStatus.DEGRADED, response.status)
        assertEquals("INPUT_METHOD_WINDOW_ROOT_UNAVAILABLE", response.reasonCode)
    }
}
