---
name: traceroot
description: Use when setting up traceroot tracing in a repository, reading traces, detector findings, or evaluations with the traceroot CLI, or finding the right traceroot docs page.
metadata:
  author: traceroot
  version: "1.0"
---

# traceroot

traceroot is an open-source platform for tracing AI agents and improving them from what the traces show. It captures LLM calls, tool calls, and agent steps with Python and TypeScript SDKs built on OpenTelemetry.

## Set up tracing in a repository

Follow the setup prompt in https://traceroot.ai/docs/getting-started/coding-agents.md. Use `npx -y traceroot-cli@latest setup --no-input` rather than adding the SDK by hand: it gets the API key and writes the instrumentation task, and rerunning the same command with `--resume` confirms the first trace. With no credential it exits 3, and that page covers signing in.

## Common mistakes

- **Where to initialize:** call `initialize()` where the application starts, such as the `if __name__ == "__main__":` block in Python or the framework's startup under a server like uvicorn, not at module scope, so a test that imports the module doesn't send traces. Most integration pages put `initialize()` at the top of the file for brevity: copy what they call, not where, unless the text asks for a placement such as before an import. Run tests with `TRACEROOT_ENABLED=false`.
- **`.env` files:** neither SDK loads them. Load the file in your code or export the variables.
- **`setup` finishing:** exit 0 doesn't mean setup is done. It's done when it prints a link to the first trace. Its messages go to stderr.
- **Span input and output:** `traceroot traces get <id> --json` leaves them `null`. Add `--fields full`.
- **Reading traces:** use the CLI, from the directory you ran setup in. Without a global install, use `npx -y traceroot-cli@latest`. After a browser login anywhere else, pass `--project <id>`, or reads exit 2. The docs MCP at https://traceroot.ai/docs/mcp searches the docs only.
- **Secrets:** don't print an API key or commit the file that holds it.

## Where to look next

- All pages: https://traceroot.ai/docs/llms.txt
- Coding agents, skills, and docs MCP: https://traceroot.ai/docs/getting-started/coding-agents.md
- Tracing setup by hand, self-hosting, and troubleshooting: https://traceroot.ai/docs/tracing/get-started.md
- CLI: https://traceroot.ai/docs/cli/get-started.md, https://traceroot.ai/docs/cli/reference.md for every command, https://traceroot.ai/docs/cli/scripting.md for JSON output and exit codes, and `traceroot <command> --help` for every flag
- Integrations: https://traceroot.ai/docs/integrations/overview.md
- Evaluations: https://traceroot.ai/docs/evals/get-started.md
- Detectors: https://traceroot.ai/docs/detectors/introduction.md
- Alerts: https://traceroot.ai/docs/alerts/overview.md
