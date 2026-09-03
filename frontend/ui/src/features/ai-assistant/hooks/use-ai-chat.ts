"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import { useAIStream, type LiveToolResult } from "./use-ai-stream";
import { mapDbMessages } from "../utils/map-db-messages";
import { invalidationKeysForResult } from "../lib/resource-invalidation";
import type { AISession, AIMessage, AiTraceContext } from "../types";
import type { ModelSelection } from "../components/model-selector";

const EMPTY_SELECTION: ModelSelection = { model: "", provider: "", source: "system", adapter: "" };

interface UseAiChatOptions extends AiTraceContext {
  projectId: string | undefined;
  initialSessionId?: string; // pre-load an existing session (e.g. RCA session from Step 2)
}

export function useAiChat({
  projectId,
  traceId,
  traceSessionId,
  initialSessionId,
}: UseAiChatOptions) {
  const queryClient = useQueryClient();

  // The session the panel is currently displaying. Streams for OTHER sessions
  // keep running into their own buckets; only this one is rendered.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  // Ref mirror for reads inside async callbacks without re-binding them.
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const handleToolResult = useCallback(
    (event: LiveToolResult) => {
      // Refetch whatever the write just made stale, immediately: the agent
      // wrote server-side, so no cached list knows the resource exists, and a
      // user watching the panel never produces a focus refetch. This runs per
      // tool result and without session/project guards — a background
      // session's write still leaves that project's cache stale, and
      // refetching can only ever be harmless. Invalidation is the ONLY
      // reaction to a write: created resources appear in their lists; the
      // panel never navigates the user anywhere.
      for (const queryKey of invalidationKeysForResult(event.result)) {
        void queryClient.invalidateQueries({ queryKey });
        broadcastQueryInvalidation(queryKey);
      }
    },
    [queryClient],
  );

  const {
    messagesBySession,
    streamingSessions,
    isSessionStreaming,
    sendMessage,
    setSessionMessages,
    appendUserMessage,
    resolvePendingDecision,
    abortSession,
    abortAll,
    clearAll,
    removeSession,
  } = useAIStream({
    onToolResult: handleToolResult,
  });

  // Ref mirror of the message buckets so handleSend can look for a parked
  // decision without re-binding on every stream delta.
  const messagesBySessionRef = useRef(messagesBySession);
  messagesBySessionRef.current = messagesBySession;
  // Parked calls with a decision POST in flight (toolCallId → sessionId). A
  // step stays `pending` until the server accepts the decision, so without
  // this mark a second reply (or a card click racing a typed one) would
  // re-target the same call — and its 409 would fall through to a plain send
  // that aborts the very run executing the first decision.
  const decidingRef = useRef<Map<string, string>>(new Map());

  // Set so concurrent ensureSession calls don't cancel each other; handleClose
  // aborts all in-flight POST /sessions to prevent post-close resurrection.
  const ensureSessionAbortersRef = useRef<Set<AbortController>>(new Set());
  // The in-flight session creation, shared so sends arriving before the first
  // one resolves await the same promise instead of creating duplicate sessions.
  const pendingSessionRef = useRef<Promise<string | null> | null>(null);
  // Session-boundary generation. Every action that changes which session the
  // panel is on (New Session, selecting from history, an externally chosen
  // initial session, close, project switch) bumps it; a send whose creation
  // resolves across a boundary must not commit
  // its session as active — the message still delivers to the session it was
  // created for, which stays reachable via history.
  const sessionEpochRef = useRef(0);
  // Hard boundaries (close, project switch) additionally invalidate the send
  // itself: unlike a session switch — where the message still delivers in the
  // background — a send crossing a hard boundary must not start a run at all.
  const hardBoundaryEpochRef = useRef(0);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // activeSends covers the gap between user hitting send and isStreaming
  // becoming true (session creation + first network round-trip). Without this,
  // React 19 can batch setIsStreaming(true) and setIsStreaming(false) into a
  // single frame, hiding the button. A count rather than a boolean: sends can
  // overlap (a pre-close send settling after a post-reopen send started), and
  // the first one finishing must not blank the waiting state of the second.
  // Functional updaters keep the count exact across overlaps.
  const [activeSends, setActiveSends] = useState(0);
  // Lives here (not in the input) so the pick survives the panel remounting in a
  // different host, and in localStorage so it survives a reload. Keyed per
  // project — the only id this hook has; the model catalog itself is
  // workspace-scoped.
  const [modelSelection, setModelSelection] = useLocalStorage<ModelSelection>(
    `traceroot:ai-assistant:model:v1:${projectId ?? ""}`,
    EMPTY_SELECTION,
  );

  // Reset chat state when the user navigates to a different project so a
  // session ID from project A can never be replayed against project B's chat
  // route. Aborting all runs is deliberate: a project switch is a hard
  // boundary, unlike session switches within a project which keep streams
  // alive. Within the same project, traceSessionId / traceId can change while
  // the chat is active — those don't reset; the latest values flow into
  // handleSend below. When initialSessionId is set, the loading useEffect
  // below owns session selection, so we bail here to avoid clobbering it.
  useEffect(() => {
    if (initialSessionId) return;
    sessionEpochRef.current++;
    hardBoundaryEpochRef.current++;
    setActiveSessionId(null);
    // Discard any in-flight session creation too — a send racing the switch
    // must not hand the new project a session created for the old one.
    for (const ac of ensureSessionAbortersRef.current) ac.abort();
    ensureSessionAbortersRef.current.clear();
    pendingSessionRef.current = null;
    abortAll();
    clearAll();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When initialSessionId is provided, load that session's messages on mount /
  // change — unless it is currently streaming, in which case its live bucket
  // is more complete than the DB (which only gets the assistant row at run
  // end). Stale fetches can't clobber other sessions: the response is written
  // to the bucket of the session it was fetched for.
  useEffect(() => {
    if (!initialSessionId || !projectId) return;
    // An externally chosen session (e.g. opening an RCA chat) is a session
    // boundary like any other — fence out commits from in-flight sends.
    sessionEpochRef.current++;
    setActiveSessionId(initialSessionId);
    if (isSessionStreaming(initialSessionId)) return;

    const ac = new AbortController();
    fetch(`/api/projects/${projectId}/ai/sessions/${initialSessionId}/messages`, {
      signal: ac.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (ac.signal.aborted || !data) return;
        // A run may have started in this session while the fetch was in
        // flight — the stale load must not wipe the live turn.
        if (isSessionStreaming(initialSessionId)) return;
        setSessionMessages(initialSessionId, mapDbMessages(data.messages || []));
      })
      .catch((err) => {
        if (err?.name !== "AbortError")
          console.error("[AI Chat] Failed to load initial session:", err);
      });
    return () => ac.abort();
  }, [initialSessionId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy session creation — only when first message is sent. The fetch is
  // cancellable so handleClose can prevent a pending response from resurrecting
  // the active session after we've cleared it. Caller commits the id on success.
  const ensureSession = useCallback((): Promise<string | null> => {
    if (activeSessionIdRef.current) return Promise.resolve(activeSessionIdRef.current);
    if (!projectId) return Promise.resolve(null);
    if (pendingSessionRef.current) return pendingSessionRef.current;
    const creation = (async () => {
      const ac = new AbortController();
      ensureSessionAbortersRef.current.add(ac);
      try {
        const res = await fetch(`/api/projects/${projectId}/ai/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ traceId, traceSessionId }),
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
        const data = await res.json();
        return data.id;
      } catch (err) {
        if ((err as Error).name !== "AbortError") console.error(err);
        return null;
      } finally {
        ensureSessionAbortersRef.current.delete(ac);
      }
    })();
    pendingSessionRef.current = creation;
    // Only clear our own entry: a project switch may have already discarded
    // this creation and parked a newer one in the ref.
    creation.finally(() => {
      if (pendingSessionRef.current === creation) pendingSessionRef.current = null;
    });
    return creation;
  }, [projectId, traceId, traceSessionId]);

  /**
   * The ACTIVE session's parked tool step, if any — synchronous, so the send
   * path can tell "revision" from "normal message" without an await boundary
   * that would let session/project switches interleave into a plain send.
   * Background sessions' parked decisions are never picked up — only the
   * session the user is looking at.
   */
  const findActiveParkedStep = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!projectId || !sessionId) return null;
    const step = (messagesBySessionRef.current[sessionId] ?? []).find(
      (m) =>
        m.role === "tool_step" &&
        m.toolStep?.pending !== undefined &&
        !decidingRef.current.has(m.toolStep.toolCallId),
    )?.toolStep;
    return step?.pending ? { sessionId, step, pending: step.pending } : null;
  }, [projectId]);

  /** True while a decision POST is in flight for one of this session's calls. */
  const hasDecisionInFlight = useCallback((sessionId: string | null) => {
    if (!sessionId) return false;
    for (const owner of decidingRef.current.values()) if (owner === sessionId) return true;
    return false;
  }, []);

  /**
   * Resolve a parked decision as a revision carrying the user's message.
   * Returns true when the message's job is done: the revision landed — the
   * declined tool result delivers the words to the model on the still-open
   * turn, which re-proposes in place — or someone decided first (409), in
   * which case the run is already acting on that decision and the reply is
   * dropped rather than sent as a message that would abort it. Returns false
   * when the decision is stale or undeliverable (expired, network failure),
   * and the caller sends the message normally so the user's text is never
   * lost.
   */
  const reviseParkedDecision = useCallback(
    async (
      target: NonNullable<ReturnType<typeof findActiveParkedStep>>,
      text: string,
    ): Promise<boolean> => {
      const { sessionId, step, pending } = target;
      const hardEpoch = hardBoundaryEpochRef.current;
      decidingRef.current.set(step.toolCallId, sessionId);
      try {
        const res = await fetch(`/api/projects/${projectId}/ai/sessions/${sessionId}/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisionId: pending.decisionId,
            action: "revise",
            text,
          }),
        });
        if (res.status === 409) {
          // Already decided elsewhere: the call is no longer parked, so the
          // card stops offering it; the stream's tool result labels the
          // outcome. The reply itself is dropped (the turn is still open).
          if (hardEpoch === hardBoundaryEpochRef.current) {
            resolvePendingDecision(sessionId, step.toolCallId, "create");
          }
          return true;
        }
        if (!res.ok) return false;
        // A hard boundary (close, project switch) crossed while the POST was
        // in flight: the revision landed server-side, but the local buckets
        // are gone — don't resurrect them with stray writes.
        if (hardEpoch === hardBoundaryEpochRef.current) {
          // The old proposal collapses to its declined line (the stream's
          // errored tool result confirms it); the re-proposal arrives as a
          // fresh pending card.
          resolvePendingDecision(sessionId, step.toolCallId, "skip");
          // The revision text is the user's message — show it as one. It is
          // deliberately NOT posted to the messages route (the model already
          // receives it via the declined tool result), and the decisions
          // endpoint does not persist it, so a history reload omits this
          // bubble. Accepted for now: the re-proposed call it produced is
          // persisted, so the transcript stays coherent.
          appendUserMessage(sessionId, text);
        }
        return true;
      } catch {
        return false;
      } finally {
        decidingRef.current.delete(step.toolCallId);
      }
    },
    [projectId, resolvePendingDecision, appendUserMessage],
  );

  const handleSend = useCallback(
    async (message: string, modelSelection: ModelSelection) => {
      if (!projectId) return;
      setActiveSends((n) => n + 1);
      try {
        // Revision by chat: while the active session has a write parked on a
        // confirmation card, the typed message IS the decision — it revises
        // the parked call instead of opening a new user turn. Falls through
        // to a normal send when the decision went stale while typing.
        const parked = findActiveParkedStep();
        if (parked) {
          if (await reviseParkedDecision(parked, message)) return;
        } else if (hasDecisionInFlight(activeSessionIdRef.current)) {
          // The parked call is being decided right now (an earlier reply, or
          // a card click). A plain send would abort the run that is about
          // to act on that decision, so the reply is dropped instead.
          return;
        }
        const epoch = sessionEpochRef.current;
        const hardEpoch = hardBoundaryEpochRef.current;
        const sessionId = await ensureSession();
        if (!sessionId) return;
        // A hard boundary crossed while the creation was in flight drops the
        // send entirely — a closed panel or an abandoned project must not
        // start a new run.
        if (hardEpoch !== hardBoundaryEpochRef.current) return;
        // Commit to the ref synchronously so a second send arriving before
        // the next render sees the session and doesn't create a duplicate —
        // unless a session boundary was crossed while the creation was in
        // flight, in which case the user has moved on and this session must
        // not be pulled back into view.
        if (epoch === sessionEpochRef.current) {
          activeSessionIdRef.current = sessionId;
          setActiveSessionId(sessionId);
        }
        sendMessage({
          sessionId,
          message,
          projectId,
          model: modelSelection.model,
          providerName: modelSelection.provider,
          source: modelSelection.source,
          traceId,
          traceSessionId,
        });
      } finally {
        setActiveSends((n) => n - 1);
      }
    },
    [
      projectId,
      traceId,
      traceSessionId,
      ensureSession,
      sendMessage,
      findActiveParkedStep,
      hasDecisionInFlight,
      reviseParkedDecision,
    ],
  );

  // Start a fresh chat. A still-running stream from the previous session keeps
  // reading in the background into its own bucket — it is never rendered here,
  // and the user can return to it via history to watch it live.
  const handleNewSession = useCallback(() => {
    sessionEpochRef.current++;
    // Drop the shared in-flight creation (without aborting it — its send still
    // needs it) so the next send opens a fresh session, and sync the ref now
    // so a send arriving before the next render doesn't reuse the old id.
    pendingSessionRef.current = null;
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
  }, []);

  // Closing the panel ends the conversation: every in-flight run is aborted,
  // and all cached sessions are dropped so the next reopen starts fresh.
  // History list remains the way back to past sessions (server-side).
  // Switching traces within the same page does NOT trigger this — the panel
  // stays open in that case.
  const handleClose = useCallback(() => {
    sessionEpochRef.current++;
    hardBoundaryEpochRef.current++;
    for (const ac of ensureSessionAbortersRef.current) ac.abort();
    ensureSessionAbortersRef.current.clear();
    // Don't wait for the aborted creation to settle and self-clear: if its
    // response is already on the wire, a send after reopen would ride the
    // pre-close creation (and its stale trace context). The self-clear's
    // identity check makes the late settle harmless once this is nulled.
    pendingSessionRef.current = null;
    abortAll();
    clearAll();
    // Sync the ref now so a send arriving before the next render opens a
    // fresh session instead of reusing the closed one.
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
  }, [abortAll, clearAll]);

  const handleOpenHistory = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions`);
      const data = await res.json();
      setSessions(data.sessions || []);
      setHistoryOpen(true);
    } catch (err) {
      console.error(err);
    }
  }, [projectId]);

  const handleSelectSession = useCallback(
    async (session: AISession) => {
      sessionEpochRef.current++;
      setActiveSessionId(session.id);
      setHistoryOpen(false);

      if (!projectId) return;
      // A streaming session's live bucket is authoritative — the DB won't have
      // the in-flight assistant response until the run completes, so loading
      // history here would make the chat appear frozen.
      if (isSessionStreaming(session.id)) return;
      try {
        const res = await fetch(`/api/projects/${projectId}/ai/sessions/${session.id}/messages`);
        if (res.ok) {
          const data = await res.json();
          // A run may have started in this session while the fetch was in
          // flight — the stale load must not wipe the live turn.
          if (isSessionStreaming(session.id)) return;
          setSessionMessages(session.id, mapDbMessages(data.messages || []));
        }
      } catch (err) {
        console.error("[AI Chat] Failed to load session messages:", err);
      }
    },
    [projectId, setSessionMessages, isSessionStreaming],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      removeSession(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        // Sync the ref now so a send arriving before the next render does
        // not post into the session that was just deleted.
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
      }
    },
    [removeSession],
  );

  /**
   * Post the user's decision on a parked write to the session's decisions
   * route. Returns true when the decision is settled — accepted, or already
   * resolved elsewhere — so the card keeps its buttons disabled and lets the
   * stream (or the local resolution) replace it; false when the request never
   * landed and the card should offer the buttons again. Never errors the
   * transcript: a 409 means someone decided first (the stream delivers the
   * outcome), and a 404 means the parked call is gone — resolved locally as
   * the skip it already became server-side.
   */
  const handleDecision = useCallback(
    async (params: {
      toolCallId: string;
      decisionId: string;
      action: "create" | "skip";
    }): Promise<boolean> => {
      const sessionId = activeSessionIdRef.current;
      if (!projectId || !sessionId) return false;
      decidingRef.current.set(params.toolCallId, sessionId);
      try {
        const res = await fetch(`/api/projects/${projectId}/ai/sessions/${sessionId}/decisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisionId: params.decisionId, action: params.action }),
        });
        if (res.ok) {
          resolvePendingDecision(sessionId, params.toolCallId, params.action);
          return true;
        }
        if (res.status === 409) return true;
        if (res.status === 404) {
          resolvePendingDecision(sessionId, params.toolCallId, "skip");
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        decidingRef.current.delete(params.toolCallId);
      }
    },
    [projectId, resolvePendingDecision],
  );

  // Aborting cuts the active session's turn short; other sessions' runs are
  // untouched.
  const handleAbort = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    abortSession(sessionId);
  }, [abortSession]);

  const messages: AIMessage[] = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const activeStreaming = activeSessionId ? !!streamingSessions[activeSessionId] : false;
  // True while the visible session has a write parked on a confirmation card
  // — the input hints that a reply revises the proposal.
  const hasPendingDecision = messages.some((m) => m.toolStep?.pending !== undefined);

  return {
    // State
    messages,
    isStreaming: activeSends > 0 || activeStreaming || messages.some((m) => m.isStreaming),
    sessions,
    historyOpen,
    currentSessionId: activeSessionId,
    modelSelection,
    hasPendingDecision,

    // Setters
    setHistoryOpen,
    setModelSelection,

    // Actions
    handleSend,
    handleDecision,
    handleAbort,
    handleNewSession,
    handleClose,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  };
}
