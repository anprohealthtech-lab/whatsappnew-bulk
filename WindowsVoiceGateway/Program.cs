using NAudio.CoreAudioApi;
using WindowsVoiceGateway;

if (args.Contains("--list-devices"))
{
    Console.WriteLine("Capture endpoints:");
    foreach (var endpoint in AudioBridge.ListEndpoints(DataFlow.Capture)) Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(endpoint));
    Console.WriteLine("Render endpoints:");
    foreach (var endpoint in AudioBridge.ListEndpoints(DataFlow.Render)) Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(endpoint));
    return;
}

var options = GatewayOptions.FromEnvironment();
var api = new GatewayApi(options);

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; shutdown.Cancel(); };
var bridge = new AudioBridge(options);

while (!shutdown.IsCancellationRequested)
{
    try
    {
        await api.HeartbeatAsync(new {
            captureDeviceId = options.CaptureDeviceId,
            renderDeviceId = options.RenderDeviceId,
            audioIsolation = true,
            platform = "windows"
        }, shutdown.Token);
        var job = await api.LeaseJobAsync(shutdown.Token);
        if (job is null) { await Task.Delay(TimeSpan.FromSeconds(options.PollSeconds), shutdown.Token); continue; }

        await api.SendEventAsync(job.Session.Id, new { type = "dialing" }, shutdown.Token);
        Console.WriteLine($"Dial on paired Android device: {job.Contact.PhoneNumber}");
        using var callShutdown = CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);
        var sessionMonitor = Task.Run(async () =>
        {
            while (!callShutdown.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), callShutdown.Token);
                var session = await api.GetSessionAsync(job.Session.Id, callShutdown.Token);
                if (session.Status is "completed" or "failed")
                {
                    callShutdown.Cancel();
                    break;
                }
            }
        }, callShutdown.Token);
        try
        {
            await bridge.RunAsync(job, (_, payload) => api.SendEventAsync(job.Session.Id, payload, shutdown.Token), callShutdown.Token);
        }
        catch (OperationCanceledException) when (callShutdown.IsCancellationRequested && !shutdown.IsCancellationRequested)
        {
            Console.WriteLine($"Call ended: {job.Contact.PhoneNumber}");
        }
        finally
        {
            callShutdown.Cancel();
            try { await sessionMonitor; } catch (OperationCanceledException) { }
        }
    }
    catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
    catch (Exception error)
    {
        Console.Error.WriteLine(error);
        await Task.Delay(TimeSpan.FromSeconds(options.PollSeconds), shutdown.Token);
    }
}
