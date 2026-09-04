"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import { useAIStream, type LiveToolResult, type TurnCompletion } from "./use-ai-stream";
import { mapDbMessages } from "../utils/map-db-messages";
import { createdDashboardRoute, isCreatedDashboardResult } from "../lib/resource-navigation";
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
  const router = useRouter();
  const queryClient = useQueryClient();

  // The session the panel is currently displaying. Streams for OTHER sessions
  // keep running into their own buckets; only this one is rendered.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  // Ref mirror for reads inside async callbacks without re-binding them.
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  // When the agent creates (or reuses) a DASHBOARD, remember it here and take
  // the user to it only once the agent's TURN completes — navigating on the
  // tool result itself would pull the user away while the agent is still
  // adding widgets. Keyed by sessionId: sessions stream concurrently, so a
  // background session's create must not overwrite the active session's
  // pending navigation, and another session's completion must not consume it.
  // The last dashboard created in a turn wins its session's slot. Cleared on
  // fire, abort, panel close, session switch/new/delete, and project change;
  // aborted or superseded streams never report completion, so a pending
  // navigation from a cut-short turn dies here unfired.
  const pendingDashboardNavsRef = useRef(new Map<string, unknown>());

  const handleToolResult = useCallback(
    (event: LiveToolResult) => {
      // Refetch whatever the write just made stale, immediately: the agent
      // wrote server-side, so no cached list knows the resource exists, and a
      // user watching the panel never produces a focus refetch. Unlike the
      // deferred navigation below this runs per tool result and without the
      // session/project guards — a background session's write still leaves
      // that project's cache stale, and refetching can only ever be harmless.
      for (const queryKey of invalidationKeysForResult(event.result)) {
        void queryClient.invalidateQueries({ queryKey });
        broadcastQueryInvalidation(queryKey);
      }
      if (isCreatedDashboardResult(event.result)) {
        pendingDashboardNavsRef.current.set(event.sessionId, event.result);
      }
    },
    [queryClient],
  );

  // Fire point for the deferred navigation. A completing turn consumes ONLY
  // its own session's entry. createdDashboardRoute holds the guards —
  // dashboards only, active session only, same project only — and is
  // evaluated HERE, against the panel's current state, not the state when the
  // tool result arrived.
  const handleTurnComplete = useCallback(
    (event: TurnCompletion) => {
      const pendingNavs = pendingDashboardNavsRef.current;
      if (!pendingNavs.has(event.sessionId)) return;
      const result = pendingNavs.get(event.sessionId);
      pendingNavs.delete(event.sessionId);
      const route = createdDashboardRoute({
        result,
        eventSessionId: event.sessionId,
        activeSessionId: activeSessionIdRef.current,
        panelProjectId: projectId,
      });
      if (route) router.push(route);
    },
    [projectId, router],
  );

  const {
    messagesBySession,
    streamingSessions,
    isSessionStreaming,
    sendMessage,
    setSessionMessages,
    resolvePendingDecision,
    abortSession,
    abortAll,
    clearAll,
    removeSession,
  } = useAIStream({
    onToolResult: handleToolResult,
    onTurnComplete: handleTurnComplete,
  });

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
    pendingDashboardNavsRef.current.clear();
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
    pendingDashboardNavsRef.current.clear();
    setActiveSessionId(initialSessionId);
    if (isSessionStreaming(initialSessionId)) return;

    const ac = new AbortController();
    fetch(`/api/projects/${projectId}/ai/sessions/${initialSessionId}/messages`, {
      signal: ac.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (ac.signal.aborted || !data) return;
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

  const handleSend = useCallback(
    async (message: string, modelSelection: ModelSelection) => {
      if (!projectId) return;
      setActiveSends((n) => n + 1);
      try {
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
    [projectId, traceId, traceSessionId, ensureSession, sendMessage],
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
    pendingDashboardNavsRef.current.clear();
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
    pendingDashboardNavsRef.current.clear();
    abortAll();
    clearAll();
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
      pendingDashboardNavsRef.current.clear();
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
      pendingDashboardNavsRef.current.delete(sessionId);
      if (activeSessionIdRef.current === sessionId) {
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
      }
    },
    [projectId, resolvePendingDecision],
  );

  // Aborting cuts the active session's turn short — its pending navigation
  // must die with it; other sessions' runs (and slots) are untouched.
  const handleAbort = useCallback(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    pendingDashboardNavsRef.current.delete(sessionId);
    abortSession(sessionId);
  }, [abortSession]);

  const messages: AIMessage[] = activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [];
  const activeStreaming = activeSessionId ? !!streamingSessions[activeSessionId] : false;

  return {
    // State
    messages,
    isStreaming: activeSends > 0 || activeStreaming || messages.some((m) => m.isStreaming),
    sessions,
    historyOpen,
    currentSessionId: activeSessionId,
    modelSelection,

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
