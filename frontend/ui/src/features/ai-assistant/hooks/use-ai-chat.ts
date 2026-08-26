"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { useAIStream } from "./use-ai-stream";
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
  const {
    messagesBySession,
    streamingSessions,
    isSessionStreaming,
    sendMessage,
    setSessionMessages,
    abortSession,
    abortAll,
    clearAll,
    removeSession,
  } = useAIStream();

  // The session the panel is currently displaying. Streams for OTHER sessions
  // keep running into their own buckets; only this one is rendered.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  // Ref mirror for reads inside async callbacks without re-binding them.
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

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
        const all: AIMessage[] = (data.messages || []).map(
          (m: { id: string; role: string; content: string; createTime: string }) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.createTime,
          }),
        );
        setSessionMessages(initialSessionId, all);
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
          const loaded: AIMessage[] = (data.messages || []).map(
            (m: { id: string; role: string; content: string; createTime: string }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.createTime,
            }),
          );
          setSessionMessages(session.id, loaded);
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
        setActiveSessionId(null);
      }
    },
    [removeSession],
  );

  const handleAbort = useCallback(() => {
    if (activeSessionIdRef.current) abortSession(activeSessionIdRef.current);
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
    handleAbort,
    handleNewSession,
    handleClose,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  };
}
