using System.Net.Http.Json;
using System.Text.Json;

namespace WindowsVoiceGateway;

public sealed class GatewayApi(GatewayOptions options)
{
    private readonly HttpClient _http = CreateClient(options);

    public async Task HeartbeatAsync(object capabilities, CancellationToken cancellationToken) =>
        await EnsureSuccess(await _http.PostAsJsonAsync("/api/voice/gateway/heartbeat", new { capabilities }, cancellationToken));

    public async Task<GatewayJob?> LeaseJobAsync(CancellationToken cancellationToken)
    {
        var response = await _http.PostAsJsonAsync("/api/voice/gateway/jobs/lease", new { }, cancellationToken);
        await EnsureSuccess(response);
        var envelope = await response.Content.ReadFromJsonAsync<JobEnvelope>(cancellationToken: cancellationToken);
        return envelope?.Job;
    }

    public async Task SendEventAsync(string sessionId, object payload, CancellationToken cancellationToken) =>
        await EnsureSuccess(await _http.PostAsJsonAsync($"/api/voice/gateway/sessions/{sessionId}/events", payload, cancellationToken));

    public async Task<GatewaySessionState> GetSessionAsync(string sessionId, CancellationToken cancellationToken)
    {
        var response = await _http.GetAsync($"/api/voice/gateway/sessions/{sessionId}", cancellationToken);
        await EnsureSuccess(response);
        return await response.Content.ReadFromJsonAsync<GatewaySessionState>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Gateway session response was empty");
    }

    private static HttpClient CreateClient(GatewayOptions options)
    {
        var client = new HttpClient { BaseAddress = new Uri(options.MainAppBaseUrl) };
        client.DefaultRequestHeaders.Add("x-voice-device-id", options.DeviceId);
        client.DefaultRequestHeaders.Add("x-voice-device-token", options.DeviceToken);
        return client;
    }

    private static async Task EnsureSuccess(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode) return;
        throw new HttpRequestException($"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
    }
}

public sealed record JobEnvelope(GatewayJob? Job);
public sealed record GatewayJob(CallSession Session, Campaign Campaign, CampaignContact Contact, string SessionToken);
public sealed record CallSession(string Id);
public sealed record Campaign(string Id, string Name);
public sealed record CampaignContact(string Id, string PhoneNumber, string? Name, JsonElement Variables);
public sealed record GatewaySessionState(string Id, string Status);
