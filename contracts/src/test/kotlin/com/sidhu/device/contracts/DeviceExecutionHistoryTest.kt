package com.sidhu.device.contracts

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceExecutionHistoryTest {
    @Test
    fun normalizesAndBoundsTheSummary() {
        val normalized = DeviceExecutionStep(
            stepId = "step-1",
            stepSummary = "  inspect\n list ",
            command = DeviceCommand.Tap(1, 2),
        )
        val bounded = DeviceExecutionStep(
            stepId = "step-2",
            stepSummary = "x".repeat(700),
            command = DeviceCommand.Back,
        )

        assertEquals("inspect list", normalized.stepSummary)
        assertEquals(500, bounded.stepSummary.length)
    }

    @Test
    fun resultPreservesTheRealReceipt() {
        val step = DeviceExecutionStep(
            stepId = "step-1",
            stepSummary = "go back",
            command = DeviceCommand.Back,
        )
        val receipt = DeviceReceipt(
            command = DeviceCommand.Back,
            outcome = DeviceReceipt.Outcome.FAILED,
            detail = "binder unavailable",
        )

        assertEquals(receipt, DeviceExecutionStepResult(step, receipt).receipt)
    }
}
