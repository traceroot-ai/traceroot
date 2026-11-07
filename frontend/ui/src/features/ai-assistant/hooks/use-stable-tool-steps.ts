import { useRef } from "react";
import type { AIMessage } from "../types";

/**
 * The transcript's tool-step entries, identity-stable across renders that
 * changed none of them. A streamed delta replaces the messages array on every
 * tick while reusing each untouched tool-step object, so pinning this list to
 * its previous identity (when its members are unchanged) lets everything
 * derived from the tool steps — memoized rows, the known-resources map, the
 * composer's pending decision — stand still under streaming text.
 */
export function useStableToolSteps(messages: readonly AIMessage[]): readonly AIMessage[] {
  const prevRef = useRef<readonly AIMessage[]>([]);
  const next = messages.filter((m) => m.role === "tool_step" && m.toolStep !== undefined);
  const prev = prevRef.current;
  const unchanged = prev.length === next.length && next.every((m, i) => m === prev[i]);
  if (!unchanged) prevRef.current = next;
  return unchanged ? prev : next;
}
