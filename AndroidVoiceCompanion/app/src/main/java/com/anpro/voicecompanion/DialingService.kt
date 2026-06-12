package com.anpro.voicecompanion

import android.Manifest
import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.IBinder
import android.os.SystemClock
import android.telephony.TelephonyManager
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class DialingService : Service() {
    private val client = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
    @Volatile private var running = true
    private var lastDialedSessionId: String? = null
    @Volatile private var activeSessionId: String? = null
    @Volatile private var callWasOffHook = false
    @Volatile private var connectedAtElapsedMs: Long? = null
    private var baseUrl = ""
    private var deviceId = ""
    private var token = ""

    private val phoneStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val state = intent?.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
            val sessionId = activeSessionId ?: return
            when (state) {
                TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                    if (callWasOffHook) return
                    callWasOffHook = true
                    connectedAtElapsedMs = SystemClock.elapsedRealtime()
                    updateNotification("Call connected")
                    reportInBackground(sessionId, "connected")
                }
                TelephonyManager.EXTRA_STATE_IDLE -> {
                    if (!callWasOffHook) return
                    val duration = connectedAtElapsedMs?.let {
                        ((SystemClock.elapsedRealtime() - it) / 1000).coerceAtLeast(0)
                    } ?: 0
                    updateNotification("Call ended - waiting for next job")
                    reportInBackground(sessionId, "ended", duration)
                    activeSessionId = null
                    callWasOffHook = false
                    connectedAtElapsedMs = null
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        registerReceiver(phoneStateReceiver, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        baseUrl = intent?.getStringExtra("baseUrl")?.trimEnd('/') ?: return START_NOT_STICKY
        deviceId = intent.getStringExtra("deviceId") ?: return START_NOT_STICKY
        token = intent.getStringExtra("token") ?: return START_NOT_STICKY
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
                        updateNotification("Dialing $phone")
                        report(baseUrl, deviceId, token, sessionId, "dialing")
                        activeSessionId = sessionId
                        callWasOffHook = false
                        connectedAtElapsedMs = null
                        dial(phone)
                        lastDialedSessionId = sessionId
                    }
                    TimeUnit.SECONDS.sleep(3)
                } else {
                    updateNotification("Connected - waiting for campaign jobs")
                    TimeUnit.SECONDS.sleep(3)
                }
            } catch (error: Exception) {
                updateNotification("Connection error: ${error.message ?: error.javaClass.simpleName}")
                TimeUnit.SECONDS.sleep(5)
            }
        }
    }

    private fun dial(phone: String) {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED)
            error("Phone permission is not allowed")
        startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(phone)}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(1, notification(text))
    }

    private fun report(baseUrl: String, deviceId: String, token: String, sessionId: String, type: String) {
        report(baseUrl, deviceId, token, sessionId, type, null)
    }

    private fun report(
        baseUrl: String,
        deviceId: String,
        token: String,
        sessionId: String,
        type: String,
        durationSeconds: Long?
    ) {
        val body = JSONObject().put("type", type)
        if (durationSeconds != null) body.put("durationSeconds", durationSeconds)
        if (type == "ended") body.put("outcome", "completed")
        post(baseUrl, deviceId, token, "/api/voice/gateway/sessions/$sessionId/events", body)
    }

    private fun reportInBackground(sessionId: String, type: String, durationSeconds: Long? = null) {
        Thread {
            try {
                report(baseUrl, deviceId, token, sessionId, type, durationSeconds)
            } catch (error: Exception) {
                updateNotification("Call state sync error: ${error.message ?: error.javaClass.simpleName}")
            }
        }.start()
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

    override fun onDestroy() {
        running = false
        unregisterReceiver(phoneStateReceiver)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
