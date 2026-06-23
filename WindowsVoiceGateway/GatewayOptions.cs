namespace WindowsVoiceGateway;

public sealed class GatewayOptions
{
    public required string MainAppBaseUrl { get; init; }
    public required string VoiceServiceWebSocketUrl { get; init; }
    public required string DeviceId { get; init; }
    public required string DeviceToken { get; init; }
    public string? CaptureDeviceId { get; init; }
    public string? RenderDeviceId { get; init; }
    public int PollSeconds { get; init; } = 3;
    public double UtteranceSeconds { get; init; } = 2.0;

    public static GatewayOptions FromEnvironment() => new()
    {
        MainAppBaseUrl = Required("VOICE_MAIN_APP_URL").TrimEnd('/'),
        VoiceServiceWebSocketUrl = Required("VOICE_SERVICE_WS_URL"),
        DeviceId = Required("VOICE_GATEWAY_DEVICE_ID"),
        DeviceToken = Required("VOICE_GATEWAY_DEVICE_TOKEN"),
        CaptureDeviceId = Environment.GetEnvironmentVariable("VOICE_CAPTURE_DEVICE_ID"),
        RenderDeviceId = Environment.GetEnvironmentVariable("VOICE_RENDER_DEVICE_ID"),
        PollSeconds = int.TryParse(Environment.GetEnvironmentVariable("VOICE_JOB_POLL_SECONDS"), out var pollSeconds) ? pollSeconds : 3,
        UtteranceSeconds = double.TryParse(Environment.GetEnvironmentVariable("VOICE_UTTERANCE_SECONDS"), out var utteranceSeconds)
            ? Math.Clamp(utteranceSeconds, 1.0, 8.0)
            : 2.0
    };

    private static string Required(string name) =>
        Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"{name} is required");
}
