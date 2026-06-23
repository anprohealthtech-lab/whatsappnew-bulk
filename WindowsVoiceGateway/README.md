# Windows Voice Gateway Prototype

This prototype leases voice campaign jobs from the main app and bridges dedicated Windows WASAPI endpoints to `VoiceAgentService`.

It deliberately refuses to use Windows default devices. Set exact Bluetooth HFP capture and virtual-call render endpoint IDs:

```powershell
dotnet run -- --list-devices
$env:VOICE_MAIN_APP_URL="https://main.example.com"
$env:VOICE_SERVICE_WS_URL="wss://voice.example.com/gateway/media"
$env:VOICE_GATEWAY_DEVICE_ID="..."
$env:VOICE_GATEWAY_DEVICE_TOKEN="..."
$env:VOICE_CAPTURE_DEVICE_ID="{caller-audio-endpoint}"
$env:VOICE_RENDER_DEVICE_ID="{call-microphone-endpoint}"
$env:VOICE_UTTERANCE_SECONDS="2"
dotnet run
```

The render endpoint must feed only the phone's HFP microphone path. Do not select a normal speaker, system loopback, or physical microphone.

`VOICE_UTTERANCE_SECONDS` controls how often caller audio is sent to the voice service. Lower values feel faster in Q&A mode. The gateway clamps it between 1 and 8 seconds; default is 2 seconds.
