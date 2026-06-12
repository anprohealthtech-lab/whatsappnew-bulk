package com.anpro.voicecompanion

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.IBinder
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class DialingService : Service() {
    private val client = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
    @Volatile private var running = true
    private var lastDialedSessionId: String? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val baseUrl = intent?.getStringExtra("baseUrl")?.trimEnd('/') ?: return START_NOT_STICKY
        val deviceId = intent.getStringExtra("deviceId") ?: return START_NOT_STICKY
        val token = intent.getStringExtra("token") ?: return START_NOT_STICKY
        startForeground(1, notification("Waiting for campaign jobs"))
        Thread { poll(baseUrl, deviceId, token) }.start()
        return START_STICKY
    }

    private fun poll(baseUrl: String, deviceId: String, token: String) {
        while (running) {
            try {
                val response = get(baseUrl, deviceId, token, "/api/voice/gateway/jobs/active-dial")
                val job = response.optJSONObject("job")
                if (job != null) {
                    val sessionId = job.getJSONObject("session").getString("id")
                    val phone = job.getJSONObject("contact").getString("phoneNumber")
                    if (sessionId != lastDialedSessionId) {
                        lastDialedSessionId = sessionId
                        report(baseUrl, deviceId, token, sessionId, "dialing")
                        dial(phone)
                    }
                    TimeUnit.SECONDS.sleep(3)
                } else TimeUnit.SECONDS.sleep(3)
            } catch (_: Exception) {
                TimeUnit.SECONDS.sleep(5)
            }
        }
    }

    private fun dial(phone: String) {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) return
        startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(phone)}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun report(baseUrl: String, deviceId: String, token: String, sessionId: String, type: String) {
        post(baseUrl, deviceId, token, "/api/voice/gateway/sessions/$sessionId/events", JSONObject().put("type", type))
    }

    private fun post(baseUrl: String, deviceId: String, token: String, path: String, body: JSONObject): JSONObject {
        val request = Request.Builder().url(baseUrl + path)
            .header("x-voice-device-id", deviceId).header("x-voice-device-token", token)
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error(response.body?.string() ?: "HTTP ${response.code}")
            return JSONObject(response.body?.string() ?: "{}")
        }
    }

    private fun get(baseUrl: String, deviceId: String, token: String, path: String): JSONObject {
        val request = Request.Builder().url(baseUrl + path)
            .header("x-voice-device-id", deviceId).header("x-voice-device-token", token).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) error(response.body?.string() ?: "HTTP ${response.code}")
            return JSONObject(response.body?.string() ?: "{}")
        }
    }

    private fun notification(text: String): Notification {
        val channelId = "voice-campaign"
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(channelId, "Voice campaigns", NotificationManager.IMPORTANCE_LOW)
        )
        return NotificationCompat.Builder(this, channelId).setContentTitle("AnPro Voice Companion")
            .setContentText(text).setSmallIcon(android.R.drawable.sym_action_call).build()
    }

    override fun onDestroy() { running = false; super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
