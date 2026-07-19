package com.sidhu.device.runtime.android.privileged

import java.io.InputStream
import java.io.OutputStream
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class ProcessExitWaiterTest {
    @Test
    fun waitsByPollingExitValueWhenRemoteProcessDoesNotSupportTimedWaitFor() = runBlocking {
        var exitChecks = 0
        val process = object : Process() {
            override fun getInputStream(): InputStream = InputStream.nullInputStream()
            override fun getErrorStream(): InputStream = InputStream.nullInputStream()
            override fun getOutputStream(): OutputStream = OutputStream.nullOutputStream()
            override fun waitFor(): Int = 0
            override fun waitFor(timeout: Long, unit: java.util.concurrent.TimeUnit): Boolean =
                throw UnsupportedOperationException("process hasn't exited")
            override fun exitValue(): Int {
                exitChecks += 1
                if (exitChecks < 3) throw IllegalThreadStateException("still running")
                return 0
            }
            override fun destroy() = Unit
        }

        assertTrue(waitForProcessExit(process, timeoutMs = 200L, pollMs = 1L))
    }
}
