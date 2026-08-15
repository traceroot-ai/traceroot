# Cross-language evaluation identity

Platform-owned identity model that lets equivalent Python and TypeScript runs appear under
one logical evaluation while staying distinct runs. Additive + backward compatible. The SDK
agent confirms it can populate the shape (no SDK-agent contract doc existed in the repo at
implementation time — the platform defines the canonical Zod/Pydantic/OpenAPI shape, as it
did for [emitted metrics](./scorer-metric-contract.md)).

## The defect this fixes

The evaluation's grouping identity WAS the display name: `uq_evaluation_project_name` on
`(project_id, name)`. So two logically-identical evaluations could only group if both SDKs
emitted the byte-identical `evaluation_name`, and two different evaluations could never
share a display name. Language was never the split — a Python and a TypeScript run with the
same name already grouped — but the identity was fragile (tied to a human label).

## Identity hierarchy

```
Evaluation definition   (project_id, evaluation_key)   — stable, cross-language, cross-run
  Evaluation run        unique run id, run_number       — one execution (idempotent on client_run_id)
    Candidate           candidate_version               — what changed (model/prompt/code label)
    Provenance          run.provenance                  — sdk_language/version, git, CI, declared model
  Scorer definition     scorers[].name (semantic)       — shared across implementations
    Scorer version      scorers[].version               — a specific implementation/config
    Emitted metric      Score.scorer_name               — a named value (see scorer-metric-contract.md)
```

- **Evaluation definition** = `(project_id, evaluation_key)`. Runs sharing a key group under
  one definition regardless of SDK language; two evaluations may share a display `name`
  under different keys.
- **Run** = always a new `id` + `run_number`; idempotent on `client_run_id`.
- **Provenance** (already in the contract) carries `sdk_language`/`sdk_version`, git and CI —
  the language is provenance, never identity.

## Wire contract (additive)

`RegisterRunRequest.evaluation_key` — `string?`, optional. The stable semantic identity,
decoupled from `evaluation_name`. Omitted by older SDKs → the platform falls back to the
name. Mirrored in Zod (`eval-contract.ts`), Pydantic (`rest/schemas/eval.py`), and the
public OpenAPI; cross-layer parity + behavioral fixtures cover it.

Grouping in the register route:

```ts
const evaluationKey = req.evaluation_key ?? req.evaluation_name;   // fallback = name
// find-or-create Evaluation by (projectId, evaluationKey); create stores name + key.
```

## Schema + migration (additive, safe)

`Evaluation.evaluationKey` (NOT NULL). Migration `20260808000000_add_evaluation_key`:

1. add `evaluation_key` nullable;
2. **backfill `evaluation_key = name`** (every existing evaluation keeps today's grouping);
3. set NOT NULL;
4. drop `uq_evaluation_project_name`, add `uq_evaluation_project_key` on `(project_id, evaluation_key)`.

**Backfill / ambiguity for existing records:** a pre-key evaluation is keyed by its name, so
old runs remain readable and keep grouping exactly as before. A NEW run that sends an
explicit `evaluation_key` equal to an old evaluation's name joins it; a new run whose key
differs from any old name starts a fresh definition — even if its display name matches an
old one (explicit key wins; this is the intended "same name, different key → separate").

## What did NOT change (deliberately)

- Code hash / code-source equality never determines sameness (it doesn't participate in the
  key at all).
- Runs are never merged because display names match — only the key groups.
- The frontend groups by the server-assigned `evaluationId` (evaluations-view.tsx), so
  grouping Python + TS into one `Evaluation` row groups them in the UI automatically.

## TypeScript span ingestion

The transformer classifies EVALUATION/TASK/SCORER **only** from the explicit
`traceroot.span.type` attribute (`otel_transform.py get_span_kind`), language-agnostic;
`is_evaluation` is set per eval-kind span and backfilled trace-level; nested LLM/AGENT/TOOL
spans keep their genuine kinds (they lack that attribute). This is correct for TypeScript
**iff the TS SDK emits `traceroot.span.type`** on its EVALUATION/TASK/SCORER spans. The
platform does NOT guess span roles from names.

## SDK dependencies still outstanding

- **`evaluation_key`**: the SDK should send a stable key (config-derived, not the display
  name) on registration for both languages. Until then, grouping falls back to the name.
- **Scorer semantic key**: `scorers[].name` is today's cross-language scorer identity
  (same name in Python + TS groups in the scorer catalog). An explicit `scorers[].key`
  (plus per-scorer language on the scorer/score rows) is needed to render one Scorer with
  distinct Python/TypeScript implementations — a follow-up platform pass gated on the SDK
  reporting it. NOT added as a dead contract field.
- **TS OTLP fixtures**: no raw packaged-TS-SDK OTLP payload exists in the repo, so the
  cross-surface test uses representative OTLP; a literal packaged-TS capture is SDK-owned.
- **`provenance.sdk_language`**: already in the contract; the SDK must populate it for the
  header chip to name the language.
