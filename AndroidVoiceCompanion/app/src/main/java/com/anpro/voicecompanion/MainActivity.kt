package com.anpro.voicecompanion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {
    private lateinit var baseUrl: EditText
    private lateinit var deviceId: EditText
    private lateinit var token: EditText
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val preferences = getSharedPreferences("gateway", MODE_PRIVATE)
        baseUrl = EditText(this).apply {
            hint = "Main app URL"
            setText(preferences.getString("baseUrl", "https://whatsapp-automation.limsapp.in"))
        }
        deviceId = EditText(this).apply {
            hint = "Android gateway device ID"
            setText(preferences.getString("deviceId", ""))
        }
        token = EditText(this).apply {
            hint = "Device token"
            setText(preferences.getString("token", ""))
        }
        status = TextView(this).apply { text = "Stopped" }
        val start = Button(this).apply {
            text = "Start dialing companion"
            setOnClickListener {
                if (baseUrl.text.isBlank() || deviceId.text.isBlank() || token.text.isBlank()) {
                    status.text = "Enter the URL, device ID and device token"
                    return@setOnClickListener
                }
                preferences.edit()
                    .putString("baseUrl", baseUrl.text.toString().trim())
                    .putString("deviceId", deviceId.text.toString().trim())
                    .putString("token", token.text.toString().trim())
                    .apply()
                if (hasPhonePermissions()) startCompanion() else ActivityCompat.requestPermissions(
                    this@MainActivity,
                    arrayOf(Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE),
                    100
                )
            }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
            addView(baseUrl); addView(deviceId); addView(token); addView(start); addView(status)
        })
    }

    private fun hasPhonePermissions() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

    private fun startCompanion() {
        startForegroundService(Intent(this, DialingService::class.java).apply {
            putExtra("baseUrl", baseUrl.text.toString().trim())
            putExtra("deviceId", deviceId.text.toString().trim())
            putExtra("token", token.text.toString().trim())
        })
        status.text = "Running - waiting for campaign calls"
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 100) return
        if (hasPhonePermissions()) startCompanion() else {
            status.text = "Phone permission is required"
            Toast.makeText(this, "Allow Phone permission to place campaign calls", Toast.LENGTH_LONG).show()
        }
    }
}
