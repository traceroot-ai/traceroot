import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { Message, ProviderStreamOptions, Tool, ToolCall } from "@earendil-works/pi-ai";
import { fetchProviderConfig, resolvePiModel } from "@traceroot/core/model-resolver";
import { DETECTOR_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core/llm-providers";
import { formatWindowRange } from "@traceroot/slack";
import { resolveDetectorApiKey } from "../detection/sandbox-eval.js";
import { withSelfTrace } from "../detection/self-trace-emitter.js";
import { tracedComplete } from "../detection/traced-complete.js";

export interface DigestSummaryDetectorInput {
  name: string;
  findingCount: number;
  sampleSummaries: string[];
}

export interface DigestSummaryInput {
  projectName: string;
  windowStart: Date;
  windowEnd: Date;
  detectors: DigestSummaryDetectorInput[];
}

// Hard budget on the assembled user text. The ClickHouse caps (10/detector,
// 40 total, 300 chars each) already bound this to ~13k worst case; the budget
// is belt-and-suspenders against cap drift between backend and worker. When
// exceeded we drop WHOLE detectors (never mid-sentence truncation) and
// disclose the omission to the model.
export const DIGEST_SUMMARY_MAX_PROMPT_CHARS = 16_000;

const SYSTEM_PROMPT = `You write one short alert summary for an on-call engineer from AI-detector findings on production traces.

RULES:
- You MUST call the submit_digest_summary tool to answer. Plain text responses are rejected.
- 2-4 plain sentences, roughly 50-80 words. No markdown, no bullet points.
- The FIRST sentence must stand alone: lead with severity/blast radius. Never open with the time window or "during this period".
- One detector with similar findings -> 1-2 sentences. Heterogeneous findings -> up to 4, cross-cutting read first, most severe first.
- Do not enumerate detector names and counts (the alert already lists them); add only what the list cannot say.
- When told the sentences are a sample of a larger count, do not claim they represent everything.`;

function detectorSection(d: DigestSummaryDetectorInput): string {
  const sampled = d.sampleSummaries.length;
  const noun = d.findingCount === 1 ? "trigger" : "triggers";
  if (sampled === 0) {
    // Starved out of the sample budget (or empty payloads): keep the detector
    // visible with an explicit disclosure instead of silently dropping it.
    return `DETECTOR: ${d.name} — ${d.findingCount} ${noun} (no sample available)`;
  }
  const coverage =
    d.findingCount > sampled
      ? ` (summaries below are the latest ${sampled} of ${d.findingCount} triggers)`
      : "";
  const lines = d.sampleSummaries.map((s) => `- ${s}`).join("\n");
  return `DETECTOR: ${d.name} — ${d.findingCount} ${noun}${coverage}\n${lines}`;
}

export function buildDigestSummaryPrompt(
  input: DigestSummaryInput,
): { systemPrompt: string; userText: string } | null {
  // Only bail when NO detector has sentences; detectors with triggers but no
  // sampled sentences stay in with a "(no sample available)" line.
  if (!input.detectors.some((d) => d.sampleSummaries.length > 0)) return null;

  // Largest detectors carry the window's story; keep them when over budget.
  const ordered = [...input.detectors].sort((a, b) => b.findingCount - a.findingCount);
  const header = `PROJECT: ${input.projectName}\nWINDOW: ${formatWindowRange(input.windowStart, input.windowEnd)}\n\n`;

  const sections: string[] = [];
  // Reserve room for the omission tail up front so the assembled text can
  // never exceed the cap, even when sections land exactly on the boundary.
  const TAIL_RESERVE = 64; // "(+NNNNNN more detectors omitted from this sample)\n"
  let used = header.length + TAIL_RESERVE;
  let omitted = 0;
  for (const d of ordered) {
    const section = detectorSection(d) + "\n\n";
    if (used + section.length > DIGEST_SUMMARY_MAX_PROMPT_CHARS) {
      omitted++;
      continue;
    }
    sections.push(section);
    used += section.length;
  }
  if (sections.length === 0) return null; // budget too tight for even one — nothing useful to say
  const tail =
    omitted > 0
      ? `(+${omitted} more detector${omitted === 1 ? "" : "s"} omitted from this sample)\n`
      : "";
  return { systemPrompt: SYSTEM_PROMPT, userText: header + sections.join("") + tail };
}

export function buildDigestSummaryTool(): Tool {
  return {
    name: "submit_digest_summary",
    description:
      "Submit the alert summary. You MUST call this tool to complete. Do not respond with plain text.",
    parameters: Type.Object(
      {
        summary: Type.String({
          description:
            "2-4 plain sentences (~50-80 words) for an on-call engineer. First sentence must stand alone. No markdown.",
        }),
      },
      { additionalProperties: false, required: ["summary"] },
    ),
  };
}

/** Fallback per-attempt timeout when DIGEST_SUMMARY_TIMEOUT_MS is unset or invalid. */
export const DEFAULT_DIGEST_SUMMARY_TIMEOUT_MS = 15_000;
/**
 * Ceiling on the configured timeout — every digest flush awaits this timeout
 * on a provider stall, so a fat-fingered env value must never hold alerts
 * hostage for minutes (or days).
 */
export const MAX_DIGEST_SUMMARY_TIMEOUT_MS = 60_000;

/**
 * Hard cap on the single summary attempt; the digest never waits longer.
 * Validation modeled on the detector-eval timeout parser: finite and > 0,
 * anything else falls back to the default; values above the max clamp to it
 * (that parser instead rejects above-max values, whose max is the Node timer
 * ceiling).
 * Exported for tests; called at call time (not module load) so env changes
 * apply per call.
 */
export function parseDigestSummaryTimeoutMs(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DIGEST_SUMMARY_TIMEOUT_MS;
  return Math.min(n, MAX_DIGEST_SUMMARY_TIMEOUT_MS);
}

export interface DigestSummaryModelConfig {
  // Project attribution for the self-trace: the digest-summary LLM call
  // becomes a detector-source trace in this project (the worker authenticates
  // with INTERNAL_API_SECRET, and ingest stamps the source from that).
  projectId: string;
  workspaceId: string;
  rcaModel: string | null;
  rcaProvider: string | null;
  rcaSource: string | null;
}

export interface DigestSummaryUsage {
  model: string;
  provider: string;
  isByok: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Why a flush produced no summary. Only set on attempts that got as far as the
 * LLM call, which are exactly the ones a self-trace exists for.
 */
export type DigestSummaryFailure = "timeout" | "no-summary" | "error";

/**
 * The self-trace this flush's LLM call was recorded under, when the worker
 * emitted one — stored on the digest's ai_messages row so the trace can be
 * found from Postgres; nothing else keeps the id.
 */
export interface DigestSummaryTrace {
  traceId: string;
}

export type DigestSummaryResult =
  | {
      summary: string;
      usage: DigestSummaryUsage;
      failure?: undefined;
      trace?: DigestSummaryTrace;
    }
  | {
      /** No paragraph for the digest; the caller sends it unchanged. */
      summary: null;
      failure: DigestSummaryFailure;
      /** Absent when the call never resolved (timeout, throw). */
      usage?: DigestSummaryUsage;
      /**
       * A failed attempt is only reported when its trace was emitted: that
       * trace is billed and is the one worth inspecting, and the ai_messages
       * row the caller writes is the only place its id is kept.
       */
      trace: DigestSummaryTrace;
    };

/**
 * One best-effort LLM call synthesizing the window's judge sentences into a
 * short paragraph. NO failure reaches the caller as an exception and none of
 * them stops the digest: it sends unchanged, never waits, never throws. A
 * failure resolves to `summary: null` when the attempt left a self-trace worth
 * recording, and to null when it did not. Model choice is two clean branches:
 * a valid BYOK config uses the project's rcaModel on that config; everything
 * else (system source, BYOK lookup failure) uses the detector system default.
 */
export async function generateDigestSummary(
  input: DigestSummaryInput,
  cfg: DigestSummaryModelConfig,
): Promise<DigestSummaryResult | null> {
  // Set the moment the self-trace exists. Every exit below the LLM call reports
  // it, including the ones that produce no summary: that trace was exported and
  // billed, and the caller's ai_messages row is the only thing that keeps its
  // id, so dropping it here would leave the failures — the runs most worth
  // reading — unreachable.
  let emitted: DigestSummaryTrace | undefined;
  try {
    const prompt = buildDigestSummaryPrompt(input);
    if (!prompt) return null;

    const byokConfig =
      cfg.rcaSource === "byok" && cfg.rcaProvider
        ? await fetchProviderConfig(cfg.workspaceId, cfg.rcaProvider)
        : null;
    // System calls always use the cheap detector default; a project's rcaModel
    // is sized for the RCA agent, not a short summarization. BYOK keeps the
    // project's model so the spend stays on their key. resolvePiModel can
    // throw for BYOK adapters when rcaModel is null — caught by the outer
    // try -> summary skipped.
    const model = byokConfig
      ? resolvePiModel(cfg.rcaModel ?? undefined, byokConfig)
      : resolvePiModel(DETECTOR_SYSTEM_DEFAULT_MODEL_ID, null);

    const apiKey = await resolveDetectorApiKey(cfg.workspaceId, byokConfig, model.provider);
    if (!apiKey) {
      console.warn(`[DigestSummary] no API key for provider "${model.provider}"; skipping summary`);
      return null;
    }

    const timeoutMs = parseDigestSummaryTimeoutMs(process.env.DIGEST_SUMMARY_TIMEOUT_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const messages: Message[] = [
        { role: "user", content: prompt.userText, timestamp: Date.now() },
      ];
      const options: ProviderStreamOptions = {
        apiKey,
        toolChoice: "auto",
        signal: controller.signal,
      };
      // Fresh id per flush. A window can be flushed twice (dedupe key
      // expired, stalled job re-run), and each flush makes its own LLM
      // call with fresh span ids — reusing one trace id would stack two
      // roots under it, so two flushes are two traces.
      const traceId = randomUUID().replaceAll("-", "");
      const traced = await withSelfTrace(
        {
          traceId,
          projectId: cfg.projectId,
          name: "digest-summary",
          metadata: {
            kind: "digest",
            window_start: input.windowStart.getTime(),
            window_end: input.windowEnd.getTime(),
            detectors: input.detectors.map((d) => ({ name: d.name, findingCount: d.findingCount })),
          },
        },
        () =>
          tracedComplete(
            model,
            { systemPrompt: prompt.systemPrompt, messages, tools: [buildDigestSummaryTool()] },
            options,
          ),
      );
      if (traced.selfTraced) emitted = { traceId };
      if (!traced.ok) throw traced.error;
      const response = traced.value;
      if (controller.signal.aborted || response.stopReason === "aborted") {
        console.warn(`[DigestSummary] timed out after ${timeoutMs}ms (model=${model.id})`);
        return failed("timeout", emitted);
      }
      const toolCall = response.content.find(
        (c): c is ToolCall => c.type === "toolCall" && c.name === "submit_digest_summary",
      );
      const summary =
        typeof toolCall?.arguments?.summary === "string" ? toolCall.arguments.summary.trim() : "";
      if (!summary) {
        // Include the provider's error message on error stops (sandbox-eval
        // precedent) so a 401/bad-BYOK config is diagnosable from logs.
        const errDetail = response.stopReason === "error" ? ` error=${response.errorMessage}` : "";
        console.warn(
          `[DigestSummary] no usable summary (stopReason=${response.stopReason}, model=${model.id})${errDetail}`,
        );
        return failed("no-summary", emitted, {
          model: response.model ?? model.id,
          provider: response.provider ?? model.provider,
          isByok: Boolean(byokConfig),
          inputTokens: response.usage?.input ?? 0,
          outputTokens: response.usage?.output ?? 0,
          cost: response.usage?.cost?.total ?? 0,
        });
      }
      return {
        summary,
        usage: {
          model: response.model ?? model.id,
          provider: response.provider ?? model.provider,
          isByok: Boolean(byokConfig),
          inputTokens: response.usage?.input ?? 0,
          outputTokens: response.usage?.output ?? 0,
          cost: response.usage?.cost?.total ?? 0,
        },
        ...(emitted ? { trace: emitted } : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn(`[DigestSummary] failed; sending digest without summary:`, err);
    // Everything that throws before the call (prompt, BYOK config, API key)
    // leaves `emitted` unset and reports nothing — there is no trace to find.
    return failed("error", emitted);
  }
}

/**
 * A failed attempt is only worth reporting when it left a trace behind; without
 * one there is nothing for the caller to record, so it stays null.
 */
function failed(
  failure: DigestSummaryFailure,
  trace: DigestSummaryTrace | undefined,
  usage?: DigestSummaryUsage,
): DigestSummaryResult | null {
  if (!trace) return null;
  return { summary: null, failure, trace, ...(usage ? { usage } : {}) };
}
