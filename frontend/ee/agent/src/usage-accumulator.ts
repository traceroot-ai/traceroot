import { calculateCost } from "@traceroot/core";
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
  private cost = 0;
  private totalTokens?: number;
  private model?: string;
  private provider?: string;

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
        totalTokens?: number;
        cost?: { total?: number };
      };
    };
    const usage = msg?.usage;
    if (usage) {
      this.inputTokens += usage.input ?? usage.inputTokens ?? 0;
      this.outputTokens += usage.output ?? usage.outputTokens ?? 0;
      this.cacheReadTokens += usage.cacheRead ?? 0;
      this.cacheWriteTokens += usage.cacheWrite ?? 0;
      this.cost += usage.cost?.total ?? 0;
      // Cumulative session total — last message_end wins, mirroring how the
      // live stream updates the usage footer.
      if (usage.totalTokens != null) this.totalTokens = usage.totalTokens;
    }
    if (msg?.model) this.model = msg.model;
    if (msg?.provider) this.provider = msg.provider;
  }

  async toTokenUsage(isByok: boolean): Promise<TokenUsageData | undefined> {
    if (!this.model) return undefined;

    // Use our pricing table if the stream returned 0 cost. A failing pricing
    // lookup must not lose the run: fall back to $0 and keep the tokens.
    let cost = this.cost;
    if (cost <= 0) {
      try {
        cost = await calculateCost(
          this.model,
          this.inputTokens,
          this.outputTokens,
          this.cacheReadTokens,
          this.cacheWriteTokens,
        );
      } catch (err) {
        console.error(`[Agent] Pricing lookup failed for "${this.model}":`, err);
        cost = 0;
      }
    }
    if (cost === 0 && (this.inputTokens > 0 || this.outputTokens > 0)) {
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
