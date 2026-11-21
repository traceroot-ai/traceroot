// Travel concierge: a tool-calling agent on Microsoft.Extensions.AI, traced to TraceRoot
// with nothing but the OpenTelemetry .NET SDK. There is no TraceRoot .NET SDK; TraceRoot's
// ingest endpoint speaks OTLP/HTTP protobuf and understands the GenAI semantic conventions
// that Microsoft.Extensions.AI emits.
//
//   TRACEROOT_API_KEY   project API key (required)
//   TRACEROOT_HOST_URL  API origin; defaults to https://app.traceroot.ai (self-hosted: http://localhost:8000)
//   OPENAI_API_KEY      optional; without it a scripted offline model is used so the example runs with no account
using System.ComponentModel;
using System.Diagnostics;
using Microsoft.Extensions.AI;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

const string AppSource = "travel-concierge";
const string GenAiSource = "Experimental.Microsoft.Extensions.AI";

var apiKey = Environment.GetEnvironmentVariable("TRACEROOT_API_KEY")
    ?? throw new InvalidOperationException("Set TRACEROOT_API_KEY.");
var host = (Environment.GetEnvironmentVariable("TRACEROOT_HOST_URL") ?? "https://app.traceroot.ai").TrimEnd('/');

using var tracerProvider = Sdk.CreateTracerProviderBuilder()
    .ConfigureResource(r => r.AddService("travel-concierge"))
    .AddSource(AppSource)     // your own spans
    .AddSource(GenAiSource)   // chat + execute_tool spans from Microsoft.Extensions.AI
    .AddOtlpExporter(o =>
    {
        o.Protocol = OtlpExportProtocol.HttpProtobuf;              // TraceRoot accepts protobuf only; the default is gRPC
        o.Endpoint = new Uri($"{host}/api/v1/public/traces");       // used verbatim when set in code
        o.Headers = $"Authorization=Bearer {apiKey}";
    })
    .Build();

IChatClient model = Environment.GetEnvironmentVariable("OPENAI_API_KEY") is null
    ? new ScriptedChatClient()
    : throw new NotSupportedException(
        "Add the Microsoft.Extensions.AI.OpenAI package and replace this line with " +
        "new OpenAI.Chat.ChatClient(\"gpt-4o-mini\", key).AsIChatClient(). Nothing else changes.");

IChatClient client = new ChatClientBuilder(model)
    .UseFunctionInvocation()                                       // runs the tool loop, one execute_tool span per call
    .UseOpenTelemetry(sourceName: GenAiSource, configure: c => c.EnableSensitiveData = true) // one chat span per model call
    .Build();

var options = new ChatOptions
{
    ModelId = "gpt-4o-mini",
    Tools = [AIFunctionFactory.Create(GetWeather, "get_weather"), AIFunctionFactory.Create(ConvertCurrency, "convert_currency")],
};

using var app = new ActivitySource(AppSource);
using (var run = app.StartActivity("travel_concierge.run"))
{
    run?.SetTag("traceroot.span.type", "AGENT");   // shows as an agent span in TraceRoot
    run?.SetTag("session.id", "demo-session-1");
    run?.SetTag("user.id", "demo-user");
    const string question = "I'm in Tokyo tomorrow with 20000 JPY. What's the weather and how much is that in USD?";
    run?.SetTag("traceroot.span.input", question);

    var response = await client.GetResponseAsync(question, options);

    run?.SetTag("traceroot.span.output", response.Text);
    Console.WriteLine(response.Text);
}

tracerProvider.ForceFlush();
Console.WriteLine($"Trace sent to {host}");

[Description("Get tomorrow's weather for a city.")]
static string GetWeather([Description("City name")] string city) =>
    city.ToLowerInvariant() switch
    {
        "tokyo" => "18°C, light rain in the morning clearing to sun by afternoon",
        "kyoto" => "16°C, overcast with a cool breeze",
        _ => "No forecast available",
    };

[Description("Convert an amount of money to US dollars.")]
static string ConvertCurrency([Description("Amount")] double amount, [Description("ISO currency code")] string from)
{
    var rates = new Dictionary<string, double> { ["USD"] = 1.0, ["JPY"] = 0.0064, ["EUR"] = 1.08 };
    return rates.TryGetValue(from.ToUpperInvariant(), out var rate)
        ? $"{amount * rate:F2} USD"
        : $"Unknown currency {from}";
}

/// <summary>
/// Offline stand-in for a real model: asks for both tools, then answers from their results.
/// It reports token usage like a provider would, so the trace has the same shape as a real one.
/// </summary>
sealed class ScriptedChatClient : IChatClient
{
    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var results = messages.SelectMany(m => m.Contents).OfType<FunctionResultContent>().ToList();
        ChatMessage reply = results.Count == 0
            ? new(ChatRole.Assistant,
            [
                new FunctionCallContent("call_1", "get_weather", new Dictionary<string, object?> { ["city"] = "Tokyo" }),
                new FunctionCallContent("call_2", "convert_currency", new Dictionary<string, object?> { ["amount"] = 20000, ["from"] = "JPY" }),
            ])
            : new(ChatRole.Assistant, $"Tokyo tomorrow: {results[0].Result}. Your 20000 JPY is about {results[1].Result}.");

        return Task.FromResult(new ChatResponse(reply)
        {
            ModelId = options?.ModelId ?? "scripted-model",
            FinishReason = results.Count == 0 ? ChatFinishReason.ToolCalls : ChatFinishReason.Stop,
            Usage = results.Count == 0
                ? new() { InputTokenCount = 96, OutputTokenCount = 34, TotalTokenCount = 130 }
                : new() { InputTokenCount = 171, OutputTokenCount = 29, TotalTokenCount = 200 },
        });
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await GetResponseAsync(messages, options, cancellationToken);
        foreach (var update in response.ToChatResponseUpdates()) yield return update;
    }

    public object? GetService(Type serviceType, object? serviceKey = null) =>
        serviceType.IsInstanceOfType(this) ? this : null;

    public void Dispose() { }
}
