# Microsoft.Extensions.AI Tool Agent (.NET)

A tool-calling travel concierge built on [Microsoft.Extensions.AI](https://learn.microsoft.com/dotnet/ai/microsoft-extensions-ai)
and traced end-to-end with [TraceRoot](https://traceroot.ai), using only the OpenTelemetry .NET SDK.

There is no TraceRoot .NET SDK. None is needed for tracing: TraceRoot's ingest endpoint
accepts OTLP/HTTP protobuf, and Microsoft.Extensions.AI emits the GenAI semantic
conventions TraceRoot already understands. The same setup works for anything layered on
`IChatClient`, including Semantic Kernel and Microsoft Agent Framework for .NET.

```
travel_concierge.run       AGENT
└─ orchestrate_tools       SPAN
   ├─ chat gpt-4o-mini     LLM   (model, input/output messages, tokens)
   ├─ get_weather          TOOL  (arguments, result)
   ├─ convert_currency     TOOL
   └─ chat gpt-4o-mini     LLM
```

## Setup

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download) or later and a `TRACEROOT_API_KEY`.

```bash
export TRACEROOT_API_KEY=...
# Self-hosting? Point at your API origin:
# export TRACEROOT_HOST_URL=http://localhost:8000
```

No model API key is required. Without `OPENAI_API_KEY` the example uses a small scripted
`IChatClient` that requests both tools and then answers, reporting token usage like a real
provider, so the trace has the same shape as a live one. To use a real model, add the
`Microsoft.Extensions.AI.OpenAI` package and swap the one line marked in `Program.cs`.

## Run

```bash
dotnet run
```

## What it does

- Builds a `TracerProvider` with an OTLP exporter pointed at
  `{TRACEROOT_HOST_URL}/api/v1/public/traces`, authenticated with
  `Authorization: Bearer <TRACEROOT_API_KEY>`.
- `UseOpenTelemetry()` on the chat client emits one `chat` span per model call with the
  model name, messages, and token usage.
- `UseFunctionInvocation()` runs the tool loop and emits one `execute_tool` span per call.
- A root span tagged `traceroot.span.type=AGENT` with `session.id` / `user.id` groups the
  run and sets the trace's input and output.

## Three things that silently produce an empty project

These fail without any error in the app's console output:

1. **Protocol.** The .NET OTLP exporter defaults to gRPC. TraceRoot accepts protobuf over
   HTTP only, so set `OtlpExportProtocol.HttpProtobuf`.
2. **Endpoint path.** When `Endpoint` is set in code, the exporter uses it verbatim and
   does not append a path. Give it the full `/api/v1/public/traces` URL.
3. **Source registration.** Spans from an `ActivitySource` that was not passed to
   `AddSource(...)` are dropped. Register both your own source and
   `Experimental.Microsoft.Extensions.AI` (or whatever `sourceName` you pass to
   `UseOpenTelemetry`).

Message contents are only recorded when `EnableSensitiveData = true`. This example sets
it to `true` in `Program.cs`, so prompts, model replies, and tool arguments and results
are sent to TraceRoot as-is. Set it to `false` (or remove the `configure` argument) to
keep them in process; spans, model names, and token counts are still recorded.
