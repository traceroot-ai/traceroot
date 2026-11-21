import type { TurnAttribution } from "./session.js";
import type { AgentTraceKind } from "./self-trace.js";

/** The turn kinds the agent service's routes produce. */
export type AgentTurnKind = "rca_execution" | "rca_followup" | "chat" | "loop_execution";

/** The self-trace kind of a turn is its attribution's turn kind under another name. */
export const TRACE_KIND: Record<AgentTurnKind, AgentTraceKind> = {
  rca_execution: "rca",
  rca_followup: "followup",
  chat: "chat",
  loop_execution: "loop",
};

/**
 * Who and what a messages-route turn is, from the session it lands in and the
 * caller. A system session's turn is an RCA execution, or a person's
 * follow-up; that holds for a Loop's session too, so only the turn the Loop
 * run route starts is a loop_execution. A user's session is chat.
 */
export function messageTurnAttribution(
  session: { userId: string | null },
  callerUserId: string,
): TurnAttribution & { turnKind: AgentTurnKind } {
  if (session.userId === null) {
    return callerUserId
      ? { turnKind: "rca_followup", initiatorUserId: callerUserId }
      : { turnKind: "rca_execution" };
  }
  return { turnKind: "chat" };
}
