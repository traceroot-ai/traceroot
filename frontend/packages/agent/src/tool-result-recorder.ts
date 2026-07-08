import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SessionManager, ToolResultData } from "./session.js";

type ToolCallState = Pick<ToolResultData, "toolName" | "args">;

export interface ToolResultRecorder {
  handleEvent(event: AgentEvent): void;
  flush(): Promise<void>;
}

export function createToolResultRecorder(
  sessionManager: Pick<SessionManager, "appendToolResult">,
): ToolResultRecorder {
  const toolCalls = new Map<string, ToolCallState>();
  let persistChain = Promise.resolve();

  const enqueuePersist = (params: ToolResultData) => {
    persistChain = persistChain
      .then(() => sessionManager.appendToolResult(params))
      .catch((error) => {
        console.error(
          `[Agent] Failed to persist tool result ${params.toolCallId}:`,
          error instanceof Error ? error.message : error,
        );
      });
  };

  return {
    handleEvent(event: AgentEvent): void {
      if (event.type === "tool_execution_start") {
        toolCalls.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args ?? {},
        });
        return;
      }

      if (event.type !== "turn_end" || event.toolResults.length === 0) {
        return;
      }

      for (const toolResult of event.toolResults) {
        const toolCall = toolCalls.get(toolResult.toolCallId);
        enqueuePersist({
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName || toolCall?.toolName || "unknown_tool",
          args: toolCall?.args ?? {},
          result: {
            content: toolResult.content,
            details: toolResult.details,
          },
          isError: toolResult.isError,
        });
        toolCalls.delete(toolResult.toolCallId);
      }
    },

    flush(): Promise<void> {
      return persistChain;
    },
  };
}
