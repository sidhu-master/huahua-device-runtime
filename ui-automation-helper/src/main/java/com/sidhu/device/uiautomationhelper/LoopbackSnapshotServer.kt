package com.sidhu.device.uiautomationhelper

import android.app.UiAutomation
import android.graphics.Rect
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.google.gson.Gson
import java.io.BufferedInputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

internal class LoopbackSnapshotServer(
    private val uiAutomation: UiAutomation,
    port: Int,
    private val token: String,
) : AutoCloseable {
    private val serverSocket = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
    private val closed = AtomicBoolean(false)
    private val gson = Gson()

    fun start() {
        Thread(::acceptLoop, "HuahuaUiAutomationHelper").apply {
            isDaemon = true
            start()
        }
    }

    fun awaitClose() {
        while (!closed.get()) Thread.sleep(100)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) runCatching { serverSocket.close() }
    }

    private fun acceptLoop() {
        while (!closed.get()) {
            val socket = runCatching { serverSocket.accept() }.getOrNull() ?: break
            runCatching { socket.use(::handle) }
                .onFailure { error -> Log.e(TAG, "request_failed", error) }
        }
    }

    private fun handle(socket: Socket) {
        val request = BufferedInputStream(socket.getInputStream()).readRequest()
        val authorized = constantTimeEquals(request.headers["x-uiautomation-token"].orEmpty(), token)
        when {
            !authorized -> socket.respond(401, "text/plain", "unauthorized")
            request.path == "/v1/health" -> socket.respond(200, "application/json", gson.toJson(mapOf(
                "protocol_version" to 1,
                "status" to "ready",
            )))
            request.path == "/v1/snapshot" -> socket.respond(200, "application/json", gson.toJson(snapshot()))
            request.method == "POST" && request.path == "/v1/stop" -> {
                socket.respond(200, "application/json", "{\"status\":\"stopping\"}")
                close()
            }
            else -> socket.respond(404, "text/plain", "not_found")
        }
    }

    private fun snapshot(): Map<String, Any?> {
        val nodes = mutableListOf<Map<String, Any?>>()
        var packageName = ""
        val windows = uiAutomation.windows
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.isActive }
            .ifEmpty { uiAutomation.windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION } }
        windows.forEach { window ->
            val root = window.root ?: return@forEach
            try {
                if (packageName.isEmpty()) packageName = root.packageName?.toString().orEmpty()
                appendNode(root, null, nodes)
            } finally {
                root.recycle()
            }
        }
        if (nodes.isEmpty()) {
            uiAutomation.rootInActiveWindow?.let { root ->
                try {
                    packageName = root.packageName?.toString().orEmpty()
                    appendNode(root, null, nodes)
                } finally {
                    root.recycle()
                }
            }
        }
        return mapOf(
            "foreground_package" to packageName,
            "captured_at_ms" to System.currentTimeMillis(),
            "nodes" to nodes,
        )
    }

    private fun appendNode(
        node: AccessibilityNodeInfo,
        parentIndex: Int?,
        output: MutableList<Map<String, Any?>>,
    ) {
        val index = output.size
        val bounds = Rect().also(node::getBoundsInScreen)
        output += mapOf(
            "index" to index,
            "parent_index" to parentIndex,
            "role" to node.className?.toString().orEmpty(),
            "label" to (node.text ?: node.contentDescription)?.toString().orEmpty(),
            "identifier" to node.viewIdResourceName.orEmpty(),
            "bounds" to mapOf(
                "x" to bounds.left,
                "y" to bounds.top,
                "width" to bounds.width(),
                "height" to bounds.height(),
            ),
            "visible_to_user" to node.isVisibleToUser,
            "enabled" to node.isEnabled,
            "clickable" to node.isClickable,
            "focusable" to node.isFocusable,
            "focused" to node.isFocused,
            "selected" to node.isSelected,
            "editable" to node.isEditable,
            "scrollable" to node.isScrollable,
            "active_window" to true,
            "covered" to false,
        )
        repeat(node.childCount) { childIndex ->
            node.getChild(childIndex)?.let { child ->
                try {
                    appendNode(child, index, output)
                } finally {
                    child.recycle()
                }
            }
        }
    }

    private data class HttpRequest(val method: String, val path: String, val headers: Map<String, String>)

    private fun BufferedInputStream.readRequest(): HttpRequest {
        val lines = mutableListOf<String>()
        while (lines.size < 64) {
            val line = readLine() ?: break
            if (line.isEmpty()) break
            lines += line
        }
        val parts = lines.firstOrNull().orEmpty().split(' ')
        val headers = lines.drop(1).mapNotNull { line ->
            val divider = line.indexOf(':')
            if (divider <= 0) null else line.substring(0, divider).lowercase() to line.substring(divider + 1).trim()
        }.toMap()
        return HttpRequest(parts.getOrElse(0) { "" }, parts.getOrElse(1) { "" }, headers)
    }

    private fun BufferedInputStream.readLine(): String? {
        val buffer = StringBuilder()
        while (true) {
            val value = read()
            if (value < 0) return buffer.takeIf { it.isNotEmpty() }?.toString()
            if (value == '\n'.code) return buffer.toString().trimEnd('\r')
            buffer.append(value.toChar())
            if (buffer.length > 8_192) return null
        }
    }

    private fun Socket.respond(status: Int, contentType: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        getOutputStream().use { output ->
            output.write("HTTP/1.1 $status\r\nContent-Type: $contentType\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
            output.write(bytes)
        }
    }

    private fun constantTimeEquals(actual: String, expected: String): Boolean {
        if (actual.length != expected.length) return false
        var difference = 0
        actual.indices.forEach { index -> difference = difference or (actual[index].code xor expected[index].code) }
        return difference == 0
    }

    private companion object {
        const val TAG = "HuahuaUiAutomation"
    }
}
