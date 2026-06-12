using NAudio.CoreAudioApi;
using NAudio.Wave;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace WindowsVoiceGateway;

public sealed class AudioBridge(GatewayOptions options)
{
    public static IReadOnlyList<object> ListEndpoints(DataFlow flow)
    {
        using var enumerator = new MMDeviceEnumerator();
        return enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active)
            .Select(device => (object)new { device.ID, device.FriendlyName, Flow = flow.ToString() }).ToList();
    }

    public async Task RunAsync(GatewayJob job, Func<string, object, Task> report, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.CaptureDeviceId) || string.IsNullOrWhiteSpace(options.RenderDeviceId))
            throw new InvalidOperationException("Dedicated VOICE_CAPTURE_DEVICE_ID and VOICE_RENDER_DEVICE_ID are required. Default devices are never used.");

        using var enumerator = new MMDeviceEnumerator();
        using var captureDevice = enumerator.GetDevice(options.CaptureDeviceId);
        using var renderDevice = enumerator.GetDevice(options.RenderDeviceId);
        using var capture = new WasapiCapture(captureDevice);
        using var output = new WasapiOut(renderDevice, AudioClientShareMode.Shared, true, 80);
        var playback = new BufferedWaveProvider(new WaveFormat(16000, 16, 1)) { DiscardOnBufferOverflow = true };
        output.Init(playback);
        var captured = new List<byte>();
        var captureLock = new object();

        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new Uri(options.VoiceServiceWebSocketUrl), cancellationToken);
        await SendJson(socket, new { type = "start_flow", sessionId = job.Session.Id, sessionToken = job.SessionToken }, cancellationToken);

        capture.DataAvailable += (_, args) =>
        {
            lock (captureLock) captured.AddRange(args.Buffer.Take(args.BytesRecorded));
        };

        capture.StartRecording();
        output.Play();
        await report("media_ready", new { type = "media_ready" });

        var utterancePump = Task.Run(async () =>
        {
            while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                await Task.Delay(TimeSpan.FromSeconds(4), cancellationToken);
                byte[] raw;
                lock (captureLock) { raw = captured.ToArray(); captured.Clear(); }
                if (raw.Length < capture.WaveFormat.AverageBytesPerSecond / 2) continue;
                using var wav = new MemoryStream();
                using (var writer = new WaveFileWriter(wav, capture.WaveFormat)) writer.Write(raw, 0, raw.Length);
                await SendJson(socket, new {
                    type = "audio",
                    audioBase64 = Convert.ToBase64String(wav.ToArray()),
                    mimeType = "audio/wav",
                    sessionId = job.Session.Id,
                    sessionToken = job.SessionToken
                }, cancellationToken);
            }
        }, cancellationToken);

        var receive = new byte[1024 * 128];
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            var result = await socket.ReceiveAsync(receive, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close) break;
            var json = Encoding.UTF8.GetString(receive, 0, result.Count);
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : "";
            if (type == "audio_chunk" && root.TryGetProperty("audioBase64", out var audio) && !string.IsNullOrWhiteSpace(audio.GetString()))
            {
                var mimeType = root.TryGetProperty("mimeType", out var mime) ? mime.GetString() : "";
                if (mimeType != "audio/L16") throw new InvalidOperationException("Windows prototype requires a Fish voice profile with audioFormat=pcm and 16 kHz output.");
                var samples = Convert.FromBase64String(audio.GetString()!);
                playback.AddSamples(samples, 0, samples.Length);
            }
            if (type == "flow_transcript" && root.TryGetProperty("transcript", out var flowTranscript))
                await report("transcript", new { type = "transcript", speaker = "caller", text = flowTranscript.GetString() });
            if (type == "reply")
            {
                if (root.TryGetProperty("transcript", out var transcript))
                    await report("transcript", new { type = "transcript", speaker = "caller", text = transcript.GetString() });
                if (root.TryGetProperty("text", out var agentText))
                    await report("agent_text", new { type = "agent_text", speaker = "agent", text = agentText.GetString() });
            }
        }
        await utterancePump;
    }

    private static Task SendJson(ClientWebSocket socket, object value, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
        return socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
    }
}
