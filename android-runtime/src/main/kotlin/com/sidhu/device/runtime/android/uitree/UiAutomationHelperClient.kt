package com.sidhu.device.runtime.android.uitree

import com.google.gson.JsonObject
import com.google.gson.JsonParser

data class HelperSnapshotResponse(
    val foregroundPackage: String,
    val capturedAtMs: Long,
    val nodes: List<RawUiNode>,
)

/** Parses the helper's local-only snapshot protocol. Network transport stays in the App layer. */
object UiAutomationHelperClient {
    fun parseSnapshot(body: String): HelperSnapshotResponse {
        val root = JsonParser.parseString(body).asJsonObject
        return HelperSnapshotResponse(
            foregroundPackage = root.string("foreground_package"),
            capturedAtMs = root.long("captured_at_ms"),
            nodes = root.array("nodes").map { nodeElement ->
                val node = nodeElement.asJsonObject
                RawUiNode(
                    index = node.int("index"),
                    parentIndex = node.optionalInt("parent_index"),
                    role = node.string("role"),
                    label = node.optionalString("label"),
                    identifier = node.optionalString("identifier"),
                    bounds = node.bounds(),
                    visibleToUser = node.boolean("visible_to_user", true),
                    enabled = node.boolean("enabled", true),
                    clickable = node.boolean("clickable", false),
                    focusable = node.boolean("focusable", false),
                    focused = node.boolean("focused", false),
                    editable = node.boolean("editable", false),
                    scrollable = node.boolean("scrollable", false),
                    activeWindow = node.boolean("active_window", true),
                    covered = node.boolean("covered", false),
                )
            },
        )
    }

    fun protocolFailure(httpStatus: Int): UiTreeCapture = UiTreeCapture(
        status = UiTreeStatus.DEGRADED,
        nodes = emptyList(),
        foregroundPackage = "",
        capturedAtMs = 0L,
        reasonCode = "HELPER_HTTP_$httpStatus",
    )

    private fun JsonObject.bounds(): UiTreeBounds? = getAsJsonObject("bounds")?.let { bounds ->
        UiTreeBounds(
            x = bounds.int("x"),
            y = bounds.int("y"),
            width = bounds.int("width"),
            height = bounds.int("height"),
        )
    }

    private fun JsonObject.array(name: String) = getAsJsonArray(name)?.toList().orEmpty()
    private fun JsonObject.string(name: String): String = get(name)?.asString.orEmpty()
    private fun JsonObject.optionalString(name: String): String? = get(name)?.takeUnless { it.isJsonNull }?.asString
    private fun JsonObject.int(name: String): Int = get(name)?.asInt ?: 0
    private fun JsonObject.optionalInt(name: String): Int? = get(name)?.takeUnless { it.isJsonNull }?.asInt
    private fun JsonObject.long(name: String): Long = get(name)?.asLong ?: 0L
    private fun JsonObject.boolean(name: String, default: Boolean): Boolean = get(name)?.asBoolean ?: default
}
