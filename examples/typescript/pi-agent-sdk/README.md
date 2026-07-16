# Pi Coding Agent SDK

Programmatically-embedded [Pi coding agent](https://pi.dev) session (`@earendil-works/pi-coding-agent`), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

Requires Node >=22.19 — `@earendil-works/pi-coding-agent` is ESM-only and won't run on older LTS versions.

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## The scenario

Incident INV-2041: a storefront checkout is overcharging customers who apply coupons. The demo seeds a tiny, deliberately-broken Node project into a scratch `workspace/` directory — `src/pricing.js` has a planted bug where the flat-coupon branch *adds* the discount instead of subtracting it — then drives a **single persistent `AgentSession`** through the incident end to end, the way an on-call engineer would actually use a coding agent: look before you touch, then fix, then write it up.

1. **Recon** (read-only tools: `ls`, `find`, `grep`, `read`)
   - Prompt 1: map the repo with `ls` and `find`.
   - Prompt 2: investigate the overcharge — `grep` for coupon logic, `read` `src/pricing.js`, and `read` `config/pricing.json` for a per-store override. That file doesn't exist, so this `read` call genuinely errors; the agent is told to report the error rather than treat it as fatal.
2. **Remediate** (full tool set: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`)
   - Prompt 3: run `node test/pricing.test.js` first — it genuinely fails (nonzero exit) against the planted bug — fix `src/pricing.js` with `edit`, then re-run the test to confirm it now passes.
3. **Report** (same full tool set)
   - Prompt 4: write `POSTMORTEM.md` with the root cause, the fix, and how it was verified, using `write`.

## Span tree

```
incident_inv_2041                        (observe: agent)
├─ recon                                 (observe: span)
│   ├─ AGENT  prompt 1: map the repo
│   │   └─ TOOL  ls, find
│   └─ AGENT  prompt 2: investigate the overcharge
│       └─ TOOL  grep, read, read (ERROR — config/pricing.json is missing)
├─ remediate                             (observe: span)
│   └─ AGENT  prompt 3: reproduce, fix, verify
│       └─ TOOL  bash (ERROR — test fails pre-fix), edit, bash
└─ report                                (observe: span)
    └─ AGENT  prompt 4: write POSTMORTEM.md
        └─ TOOL  write
```

Both `ERROR` spans are real failures, not staged ones: the `read config/pricing.json` call errors because that file was never created (a plausible dangling reference to a per-store override), and the first `bash` test run errors because the planted bug makes the assertion fail and the process exits nonzero.

**Span count:**

| Spans | Count | Source |
|---|---|---|
| Custom (`observe()`) | 4 | root `incident_inv_2041` + `recon` + `remediate` + `report` |
| AGENT | 4 | one per `session.prompt()` call |
| TOOL | 9 | `ls`, `find` \| `grep`, `read`, `read`(ERROR) \| `bash`(ERROR), `edit`, `bash` \| `write` — all 7 builtin tools, 2 genuine ERROR spans |
| LLM | ~7-13 | one per model turn; fewer if the model batches several tool calls into a single turn |
| **Total** | **≈24-30** | |

## One session, changing tool sets

Tool availability has two layers in `@earendil-works/pi-coding-agent`, and the distinction matters:

- **`tools` / `noTools` at `createAgentSession()` time** filter the tool **registry** itself, permanently, for the life of the session. If you pass `tools: ['read', 'grep']` at creation, no later call can ever enable `bash`, `edit`, or `write` on that session — the registry simply doesn't contain them.
- **`session.setActiveToolsByName(names)`** swaps the **active** set drawn from whatever registry the session has. It takes effect on the next turn, unknown names are silently ignored, and it never widens beyond the registry `tools`/`noTools` established at creation.

So narrow-then-widen only works if the session is created with the full registry (no `tools` option) and narrowed immediately with `setActiveToolsByName()` before the first prompt. That's what this demo does: `createAgentSession()` is called without `tools`, then `session.setActiveToolsByName(['ls', 'find', 'grep', 'read'])` runs before recon's first prompt to get genuine least-privilege read-only access, and `session.setActiveToolsByName([...all seven])` widens it before remediate's prompt once the fix actually needs to write files and run shell commands. One session, one incident, tool sets that change shape as the investigation progresses — instead of three sessions standing in for three tool configurations.

## How the tracing works

`TraceRoot.initialize({ instrumentModules: { piCodingAgent: pi } })` instruments `AgentSession` before any session is created, so every `session.prompt()` call is traced automatically with full agent/LLM/tool span semantics — no manual span code for those three layers.

This example also uses the core `@traceroot-ai/traceroot` SDK's `observe()` and `usingAttributes()` directly, for the workflow-framing spans (`incident_inv_2041`, `recon`, `remediate`, `report`) that group the four prompts into the incident narrative. Both the pi spans and these direct spans flow through the one OpenTelemetry pipeline `TraceRoot.initialize()` registers, so a single `TraceRoot.shutdown()` at the end flushes everything. `initialize()` must run before `createAgentSession()`, since wiring pi patches `AgentSession`'s prototype.

See the [pi integration docs](https://traceroot.ai/docs/integrations/pi) for the full configuration surface.
