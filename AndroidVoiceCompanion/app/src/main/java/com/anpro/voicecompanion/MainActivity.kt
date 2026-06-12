package com.anpro.voicecompanion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val baseUrl = EditText(this).apply { hint = "Main app URL" }
        val deviceId = EditText(this).apply { hint = "Android gateway device ID" }
        val token = EditText(this).apply { hint = "Device token" }
        val status = TextView(this).apply { text = "Stopped" }
        val start = Button(this).apply {
            text = "Start dialing companion"
            setOnClickListener {
                ensurePermissions()
                startForegroundService(Intent(this@MainActivity, DialingService::class.java).apply {
                    putExtra("baseUrl", baseUrl.text.toString())
                    putExtra("deviceId", deviceId.text.toString())
                    putExtra("token", token.text.toString())
                })
                status.text = "Running"
            }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
            addView(baseUrl); addView(deviceId); addView(token); addView(start); addView(status)
        })
    }

    private fun ensurePermissions() {
        val permissions = arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE)
        if (permissions.any { ActivityCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED })
            ActivityCompat.requestPermissions(this, permissions, 100)
    }
}
