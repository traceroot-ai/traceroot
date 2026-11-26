import { priceReportedCall, type ReportedCall } from "@traceroot/core";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TokenUsageData } from "./session.js";

/**
 * Accumulates token usage across a run's message_end events (one per
 * tool-use loop iteration) and resolves it into the TokenUsageData persisted
 * on the final assistant segment. Falls back to our pricing table when the
 * stream reports zero cost, warning when pricing is missing entirely so
 * unbilled runs are visible in the logs.
 */
export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalTokens?: number;
  private model?: string;
  private provider?: string;
  // One entry per message_end. Price each call on its own counts — the sum of
  // ten short prompts is not one long prompt. A positive cost is kept; 0 is
  // priced from the catalogue (including long-context rows with no flat rate).
  private calls: ReportedCall[] = [];

  onEvent(event: AgentEvent): void {
    if (event.type !== "message_end") return;
    const msg = event.message as {
      model?: string;
      provider?: string;
      usage?: {
        input?: number;
        inputTokens?: number;
        output?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cacheWrite1h?: number;
        totalTokens?: number;
        cost?: { total?: number };
      };
    };
    const usage = msg?.usage;
    if (usage) {
      const input = usage.input ?? usage.inputTokens ?? 0;
      const output = usage.output ?? usage.outputTokens ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      const cacheWrite1h = usage.cacheWrite1h ?? 0;
      const reported = usage.cost?.total ?? 0;
      this.inputTokens += input;
      this.outputTokens += output;
      this.cacheReadTokens += cacheRead;
      this.cacheWriteTokens += cacheWrite;
      if (reported > 0 || input || output || cacheRead || cacheWrite) {
        this.calls.push({
          input,
          output,
          cacheRead,
          cacheWrite,
          cacheWrite1h,
          cost: reported,
        });
      }
      // Cumulative session total — last message_end wins, mirroring how the
      // live stream updates the usage footer.
      if (usage.totalTokens != null) this.totalTokens = usage.totalTokens;
    }
    if (msg?.model) this.model = msg.model;
    if (msg?.provider) this.provider = msg.provider;
  }

  async toTokenUsage(isByok: boolean): Promise<TokenUsageData | undefined> {
    if (!this.model) return undefined;

    // Price each unpriced call on its own token counts. A failing lookup must
    // not lose the run: keep whatever the stream already reported.
    let cost = 0;
    if (this.calls.length > 0) {
      try {
        for (const call of this.calls) {
          cost += await priceReportedCall(this.model, call);
        }
      } catch (err) {
        console.error(`[Agent] Pricing lookup failed for "${this.model}":`, err);
        cost = this.calls.reduce((sum, call) => sum + (call.cost > 0 ? call.cost : 0), 0);
      }
    }
    const anyTokens =
      this.inputTokens > 0 ||
      this.outputTokens > 0 ||
      this.cacheReadTokens > 0 ||
      this.cacheWriteTokens > 0;
    // Cache-only runs bill too, so their missing pricing is just as visible.
    if (cost === 0 && anyTokens) {
      console.warn(
        `[Agent] Standard model pricing missing for "${this.model}", cost recorded as $0`,
      );
    }

    return {
      model: this.model,
      provider: this.provider || "unknown",
      isByok,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost,
      ...(this.totalTokens != null ? { totalTokens: this.totalTokens } : {}),
    };
  }
}
