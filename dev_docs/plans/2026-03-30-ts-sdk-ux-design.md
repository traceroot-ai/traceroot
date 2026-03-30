## Python vs TypeScript comparison

| Feature | Python | TypeScript |
|---|---|---|
| Init | `traceroot.initialize(integrations=[Integration.OPENAI])` | `TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } })` |
| Integrations | `Integration` enum | Module references (hoisting constraint) |
| Wrapping | `@observe(name=..., type=...)` decorator | `observe({ name, type }, async () => {...})` wrapper |
| Type values | `"span"`, `"agent"`, `"tool"`, `"llm"` | Same |
| Span updates | `update_current_span(...)` | `updateCurrentSpan(...)` |
| Trace updates | `update_current_trace(...)` | `updateCurrentTrace(...)` |
| Flush | `traceroot.flush()` | `TraceRoot.flush()` |
| Shutdown | `traceroot.shutdown()` | `TraceRoot.shutdown()` |
