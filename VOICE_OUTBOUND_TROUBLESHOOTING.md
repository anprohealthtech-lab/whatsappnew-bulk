# Voice Outbound Calling Troubleshooting Notes

## Current Architecture

Outbound campaign dialing currently uses two separate pieces:

- Android app `AnPro Voice Companion` places the real SIM call.
- `WindowsVoiceGateway` leases campaign jobs, connects to `VoiceAgentService`, and bridges audio.

For the Android app and Windows gateway to work on the same call, both must use the same gateway `Device ID` and `Device token`, and the voice campaign in the web UI must select that same gateway.

## Important URLs

- Main app URL: `https://whatsapp-automation.limsapp.in`
- Voice service WebSocket URL:
  `wss://anpro-whatsapp-bulk-chatbot-y5xix.ondigitalocean.app/gateway/media`

Do not use the main app URL for `VOICE_SERVICE_WS_URL`; that causes WebSocket `400` errors.

## Windows Gateway Command Template

```powershell
cd "D:\app folder\Whatsapp new app multi user\whatsapp multi user bulk\WindowsVoiceGateway"

$env:VOICE_MAIN_APP_URL="https://whatsapp-automation.limsapp.in"
$env:VOICE_SERVICE_WS_URL="wss://anpro-whatsapp-bulk-chatbot-y5xix.ondigitalocean.app/gateway/media"

$env:VOICE_GATEWAY_DEVICE_ID="PASTE_DEVICE_ID"
$env:VOICE_GATEWAY_DEVICE_TOKEN="PASTE_DEVICE_TOKEN"

$env:VOICE_CAPTURE_DEVICE_ID="{0.0.1.00000000}.{560998dc-7e87-400d-bddc-d3665c8e7f61}"
$env:VOICE_RENDER_DEVICE_ID="{0.0.0.00000000}.{826fcfc1-aee5-4605-8aaa-fcb5189fb70f}"

$env:VOICE_UTTERANCE_SECONDS="2"

dotnet run
```

Known cable mapping from the test machine:

- `CABLE-A Output`: `{0.0.1.00000000}.{560998dc-7e87-400d-bddc-d3665c8e7f61}`
- `CABLE-B Input`: `{0.0.0.00000000}.{826fcfc1-aee5-4605-8aaa-fcb5189fb70f}`
- `Speakers (Realtek(R) Audio)`: `{0.0.0.00000000}.{84295335-3bfb-4de3-a66f-e8baae703b24}`

## Phone Link / VB Cable Routing

System defaults or Phone Link app-specific settings should be:

- Output / speaker: `CABLE-A Input (VB-Audio Cable A)`
- Input / microphone: `CABLE-B Output (VB-Audio Cable B)`

Windows gateway should use:

- Capture/input: `CABLE-A Output`
- Render/output: `CABLE-B Input`

Signal direction:

```text
Phone Link output -> CABLE-A Input -> CABLE-A Output -> WindowsVoiceGateway capture
WindowsVoiceGateway render -> CABLE-B Input -> CABLE-B Output -> Phone Link input
```

If `WindowsVoiceGateway` logs `Playing voice audio: ... bytes`, the AI audio reached Windows. If nobody hears it, the issue is local audio routing.

For a speaker test, temporarily set:

```powershell
$env:VOICE_RENDER_DEVICE_ID="{0.0.0.00000000}.{84295335-3bfb-4de3-a66f-e8baae703b24}"
```

If welcome audio plays on laptop speakers, VoiceAgentService and TTS are working.

## Good Logs

These mean dialing and voice service are working:

```text
Dial on paired Android device: <phone>
Call audio starting in 5 seconds: <phone>
Voice service: Flow started - welcome_flow
Voice service: Flow speaking - welcome
Playing voice audio: ... bytes
Voice service: Flow listening - listen
```

These mean caller audio is not being routed clearly into the gateway:

```text
Voice service: Received audio - ... bytes
Voice service: Flow transcribing
Voice service: No speech detected
```

Check whether `CABLE-A Output` recording meter moves when the caller speaks.

## Fixes Applied

VoiceAgentService branch `voice-agent`:

- `f01a40a Handle empty gateway transcripts`
  - Prevents empty STT text from crashing platform agent call.
- `5f8bfaa Send inline flow audio to gateway`
  - Bypasses cached audio URLs for gateway PCM calls so Windows receives inline audio.

Windows gateway local change:

- Removed unsupported `media_ready` event from `WindowsVoiceGateway/AudioBridge.cs`.
- Main backend accepted event types are only:
  `dialing`, `ringing`, `connected`, `transcript`, `agent_text`, `ended`, `failed`.
- Queued AI audio chunks and played them in 20 ms frames so Phone Link/VB Cable is not flooded with the full welcome audio at once.

## Fresh Session After Deployment

If outbound calls stop dialing after a new deployment:

1. Stop old Windows gateway:

```powershell
Ctrl+C
```

If stuck:

```powershell
taskkill /IM WindowsVoiceGateway.exe /F
```

2. Create or select one gateway in the web app under `Voice Service`.
3. Copy the gateway `Device ID` and `Device token`.
4. Put the exact same ID/token in:
   - Android `AnPro Voice Companion`
   - Windows gateway env vars
   - Web UI voice campaign gateway selection
5. Force stop and reopen the Android app, then tap `Start Dialing Companion`.
6. Restart Phone Link after audio device changes:

```powershell
taskkill /IM PhoneExperienceHost.exe /F
```

7. Start Windows gateway with the command template above.
8. Start one test campaign call and watch logs.

## Vendor Alternative Notes

For production, Phone Link/VB Cable is fragile. Ask Exotel/Ozonetel/Airtel IQ/Plivo for:

```text
Bidirectional real-time media streaming for outbound calls
```

The provider must support caller audio into our server and AI audio back into the same call in real time.
