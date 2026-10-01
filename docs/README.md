# TraceRoot Documentation Guidelines

This directory contains the Mintlify documentation source for TraceRoot.

## Integration Documentation Template

All integration pages under `docs/integrations/` follow a standard structure with eight sections in order:

1. **Install (`## Install`)**:
   Provide installation commands (`pip install` and/or `npm install`) for each supported language, explicitly naming `traceroot` or `@traceroot-ai/traceroot`, any required pip extras, and the underlying framework or provider package.

2. **Set up (`## Set up`)**:
   Show the initialization code snippet (`traceroot.initialize()` or `TraceRoot.initialize()`).

3. **Usage (`## Usage`)**:
   Provide a concise, runnable code sample demonstrating tracing with the provider or framework.

4. **Verify (`## Verify`)**:
   Tell the reader how to confirm their trace arrived:
   - In the TraceRoot UI under **Tracing > Traces** (specifying the root span name).
   - Via the CLI with `traceroot traces list`.

5. **What gets captured (`## What gets captured`)**:
   A table listing attributes captured on spans (e.g. Model, Messages, Response, Tool calls, Tokens, Latency).

6. **Limitations (`## Limitations`)**:
   Document known caveats, required extras, or state "None known."

7. **Run the example (`## Run the example`)**:
   Link to the runnable sample in `examples/`.

8. **Next steps (`## Next steps`)**:
   Provide at least two internal documentation links (such as the SDK reference and cost tracking).
