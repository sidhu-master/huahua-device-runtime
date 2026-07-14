package com.sidhu.device.agent

import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class AgentAppActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(
            TextView(this).apply {
                setPadding(48, 48, 48, 48)
                text = "HuAHua Device Agent\\n\\nRuntime bootstrap is ready."
                textSize = 20f
            },
        )
    }
}
