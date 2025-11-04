"use client";

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ui/shadcn-io/ai/reasoning";
import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { processReasoningChunks } from "@/utils/streamingParser";

interface ChatReasoningProps {
  chatId: string;
  className?: string;
  isLoading?: boolean;
  userMessageTimestamp?: Date | string;
  nextMessageTimestamp?: Date | string;
}

interface ReasoningData {
  chunk_id: number;
  content: string;
  status: string;
  timestamp: string;
}

export const ChatReasoning = ({
  chatId,
  className,
  isLoading,
  userMessageTimestamp,
  nextMessageTimestamp,
}: ChatReasoningProps) => {
  const { getToken } = useAuth();
  const [reasoningData, setReasoningData] = useState<ReasoningData[]>([]);
  const [hasReasoningData, setHasReasoningData] = useState(false);
  const [shouldPoll, setShouldPoll] = useState(false);
  const [pollStartTime, setPollStartTime] = useState<number | null>(null);
  const [hasCheckedInitially, setHasCheckedInitially] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const hasAutoOpenedWhileWaitingRef = useRef(false);
  const userCollapsedWhileWaitingRef = useRef(false);
  const [postWaitDeadlineMs, setPostWaitDeadlineMs] = useState<number | null>(
    null,
  );
  const prevIsLoadingRef = useRef<boolean>(false);
  const postWaitDeadlineRef = useRef<number | null>(null);
  const isLoadingRef = useRef<boolean>(false);
  const hasCheckedInitiallyRef = useRef<boolean>(false);
  const fetchReasoningDataRef = useRef<(() => Promise<void>) | null>(null);
  const shouldPollRef = useRef<boolean>(false);
  const hasReasoningDataRef = useRef<boolean>(false);
  const pollStartTimeRef = useRef<number | null>(null);
  const callCountRef = useRef<number>(0);
  const nonLoadingCallCountRef = useRef<number>(0);

  // Keep refs in sync with state
  postWaitDeadlineRef.current = postWaitDeadlineMs;
  isLoadingRef.current = !!isLoading;
  hasCheckedInitiallyRef.current = hasCheckedInitially;
  shouldPollRef.current = shouldPoll;
  hasReasoningDataRef.current = hasReasoningData;
  pollStartTimeRef.current = pollStartTime;

  const fetchReasoningData = useCallback(async () => {
    // Increment call counters
    callCountRef.current++;
    const isCurrentlyLoading = isLoadingRef.current;

    if (!isCurrentlyLoading) {
      nonLoadingCallCountRef.current++;
      // Limit to 3 calls when not loading
      if (nonLoadingCallCountRef.current > 3) {
        setShouldPoll(false);
        setPollStartTime(null);
        return;
      }
    }

    if (!chatId) {
      return;
    }

    try {
      // Fetch reasoning data from the Next.js API route
      const token = await getToken();
      const response = await fetch(
        `/api/chat/${chatId}/reasoning?t=${Date.now()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          cache: "no-store",
        },
      );
      if (response.ok) {
        const data = await response.json();
        const reasoning = data.reasoning || [];

        setReasoningData(reasoning);

        // Only show component if we have reasoning data
        if (reasoning.length > 0) {
          setHasReasoningData(true);
          // Keep polling if the latest item is still pending; otherwise stop unless still waiting/post-wait window
          const latestItem = reasoning.sort(
            (a: ReasoningData, b: ReasoningData) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
          )[0];
          const latestPending = latestItem && latestItem.status === "pending";
          const keepPolling =
            latestPending ||
            !!postWaitDeadlineRef.current ||
            !!isLoadingRef.current;
          setShouldPoll(keepPolling);
          if (!keepPolling) {
            setPollStartTime(null);
          }
        } else {
          // No reasoning data found - keep polling if we're still loading or in post-wait window
          const keepPolling =
            !!isLoadingRef.current || !!postWaitDeadlineRef.current;
          setShouldPoll(keepPolling);
          if (keepPolling && !pollStartTimeRef.current) {
            setPollStartTime(Date.now());
          } else if (!keepPolling) {
            setPollStartTime(null);
          }
        }

        setHasCheckedInitially(true);
      } else if (response.status === 404) {
        // No reasoning data exists
        setReasoningData([]);

        // Keep polling if we're still loading or in post-wait window
        const keepPolling =
          !!isLoadingRef.current || !!postWaitDeadlineRef.current;
        setShouldPoll(keepPolling);
        if (keepPolling && !pollStartTimeRef.current) {
          setPollStartTime(Date.now());
        } else if (!keepPolling) {
          setPollStartTime(null);
        }

        setHasCheckedInitially(true);
      }
    } catch (error) {
      console.error("Error fetching reasoning data:", error);
      setShouldPoll(false);
      setPollStartTime(null);
    }
  }, [chatId, getToken]);

  // Store the latest fetchReasoningData function in a ref
  fetchReasoningDataRef.current = fetchReasoningData;

  useEffect(() => {
    // Reset call counters when chat changes
    callCountRef.current = 0;
    nonLoadingCallCountRef.current = 0;
    // Initial fetch
    fetchReasoningDataRef.current?.();
  }, [chatId]);

  // Ensure we're always polling when isLoading is true
  useEffect(() => {
    if (isLoading && !shouldPoll) {
      setShouldPoll(true);
      if (!pollStartTimeRef.current) {
        setPollStartTime(Date.now());
      }
      // Immediate fetch
      fetchReasoningDataRef.current?.();
    }
  }, [isLoading, shouldPoll]);

  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = !!isLoading;

    // Start polling immediately when loading begins - be more aggressive
    if (isLoading && !wasLoading) {
      // Reset non-loading call counter when loading starts
      nonLoadingCallCountRef.current = 0;
      setShouldPoll(true);
      setPollStartTime(Date.now());
      setHasCheckedInitially(true);
      // Kick off an immediate fetch so UI shows as soon as possible
      fetchReasoningDataRef.current?.();
    }

    // Continue polling while loading even if shouldPoll was already true
    if (isLoading && !shouldPoll) {
      setShouldPoll(true);
      if (!pollStartTimeRef.current) {
        setPollStartTime(Date.now());
      }
    }

    // Only start a short post-wait window when we transition from loading -> not loading
    if (!isLoading && wasLoading) {
      hasAutoOpenedWhileWaitingRef.current = false;
      userCollapsedWhileWaitingRef.current = false;
      if (!hasReasoningData) {
        setShouldPoll(true);
        setPostWaitDeadlineMs(Date.now() + 2000); // 2s grace just after waiting ends
      } else {
        setPostWaitDeadlineMs(null);
        setShouldPoll(false);
      }
    }
  }, [isLoading, chatId, hasReasoningData, shouldPoll]);

  // Auto-open once when waiting starts (no reasoning yet), respect manual collapse during wait
  useEffect(() => {
    if (
      isLoading && // we're waiting for assistant response
      !hasReasoningData && // no historical reasoning yet
      !hasAutoOpenedWhileWaitingRef.current &&
      !userCollapsedWhileWaitingRef.current
    ) {
      setIsOpen(true);
      hasAutoOpenedWhileWaitingRef.current = true;
    }
  }, [isLoading, hasReasoningData]);

  // Let internal Reasoning component manage open/close (respects manual collapse during streaming)

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    const interval = setInterval(() => {
      // Stop if shouldPoll became false
      if (!shouldPollRef.current) {
        return;
      }

      // Check timeout before each fetch
      if (pollStartTimeRef.current && !hasReasoningDataRef.current) {
        const elapsed = Date.now() - pollStartTimeRef.current;
        if (elapsed > 30000) {
          setShouldPoll(false);
          setPollStartTime(null);
          return;
        }
      }

      // Stop polling after post-wait grace period passes (but not while still loading!)
      if (
        postWaitDeadlineRef.current &&
        Date.now() > postWaitDeadlineRef.current &&
        !isLoadingRef.current // Only stop after grace period if we're not still loading
      ) {
        setShouldPoll(false);
        setPostWaitDeadlineMs(null);
        return;
      }

      fetchReasoningDataRef.current?.();
    }, 600); // Poll every 600ms

    return () => {
      clearInterval(interval);
    };
  }, [chatId, shouldPoll]); // Depend on shouldPoll directly

  // Filter reasoning data to only include items between user message and next message timestamps
  const filteredReasoningData = reasoningData.filter((reasoning) => {
    if (!userMessageTimestamp) return true; // Show all if no timestamp provided

    // Ensure robust timestamp parsing for both ISO strings and Date objects
    // Handle potential timezone issues by normalizing all to UTC
    let userTimeMs, reasoningTimeMs, nextTimeMs;

    try {
      // Convert all timestamps to UTC for consistent comparison
      // Handle both UTC ISO strings and local Date objects
      const userDateUTC = new Date(userMessageTimestamp);

      // Fix: Reasoning timestamps from backend lack timezone info, so they're treated as local time
      // Force them to be interpreted as UTC by appending 'Z' if not already present
      let reasoningTimestampUTC = reasoning.timestamp;
      if (
        typeof reasoningTimestampUTC === "string" &&
        !reasoningTimestampUTC.endsWith("Z") &&
        !reasoningTimestampUTC.includes("+")
      ) {
        reasoningTimestampUTC = reasoningTimestampUTC + "Z";
      }
      const reasoningDateUTC = new Date(reasoningTimestampUTC);

      const nextDateUTC = nextMessageTimestamp
        ? new Date(nextMessageTimestamp)
        : null;

      userTimeMs = userDateUTC.getTime();
      reasoningTimeMs = reasoningDateUTC.getTime();
      nextTimeMs = nextDateUTC ? nextDateUTC.getTime() : null;
    } catch (error) {
      console.error("🕒 FILTER ERROR: Timestamp parsing error:", error);
      return false; // Skip this item if timestamps can't be parsed
    }

    // Lower bound: reasoning must come after or equal to the user message
    if (reasoningTimeMs < userTimeMs) return false;

    // Upper bound: if we have a next assistant message, reasoning must come before it
    if (nextTimeMs !== null && reasoningTimeMs >= nextTimeMs) return false;

    return true;
  });

  // Determine if this specific chat's thinking is completed
  const hasCompletedReasoning =
    filteredReasoningData.length > 0 &&
    filteredReasoningData.every((r) => r.status === "completed");

  // Compute historical duration (first to last reasoning timestamp) when not streaming
  const historicalDurationSec = useMemo(() => {
    if (filteredReasoningData.length === 0) return undefined;
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const item of filteredReasoningData) {
      let ts = item.timestamp;
      if (typeof ts === "string" && !ts.endsWith("Z") && !ts.includes("+")) {
        ts = ts + "Z";
      }
      const ms = new Date(ts).getTime();
      if (!Number.isFinite(ms)) continue;
      if (minMs === null || ms < minMs) minMs = ms;
      if (maxMs === null || ms > maxMs) maxMs = ms;
    }
    if (minMs === null || maxMs === null || maxMs < minMs) return undefined;
    return Math.max(0, Math.round((maxMs - minMs) / 1000));
  }, [filteredReasoningData]);

  // If no reasoning timestamps, fall back to difference between user and next assistant timestamps
  const fallbackDurationSec = useMemo(() => {
    if (
      !historicalDurationSec &&
      userMessageTimestamp &&
      nextMessageTimestamp
    ) {
      try {
        const start = new Date(userMessageTimestamp).getTime();
        const end = new Date(nextMessageTimestamp).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          return Math.max(0, Math.round((end - start) / 1000));
        }
      } catch (_) {}
    }
    return undefined;
  }, [historicalDurationSec, userMessageTimestamp, nextMessageTimestamp]);

  // Show if we have reasoning data OR if we're currently loading/polling OR within post-wait window OR if filtered data exists
  const hasFilteredData = filteredReasoningData.length > 0;
  const withinPostWaitWindow = postWaitDeadlineMs
    ? Date.now() <= postWaitDeadlineMs
    : false;

  const shouldShow =
    hasReasoningData ||
    isLoading ||
    shouldPoll ||
    hasFilteredData ||
    withinPostWaitWindow;

  if (!shouldShow) {
    return null;
  }

  // Combine stored reasoning chunks and clean them
  const reasoningChunks = filteredReasoningData
    .filter(
      (reasoning) => reasoning.content && reasoning.content.trim().length > 0,
    )
    .sort((a, b) => {
      // First sort by chunk_id, then by timestamp for proper chronological order
      if (a.chunk_id !== b.chunk_id) {
        return a.chunk_id - b.chunk_id;
      }
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    })
    .map((reasoning) => reasoning.content);

  const combinedContent = processReasoningChunks(reasoningChunks);

  return (
    <div className={className}>
      <Reasoning
        className="w-full"
        // Once thinking is completed, it stays completed regardless of other chats
        // Only show as streaming if this specific chat doesn't have completed reasoning
        isStreaming={
          !hasCompletedReasoning &&
          (isLoading ||
            withinPostWaitWindow ||
            (shouldPoll && !hasReasoningData))
        }
        duration={historicalDurationSec ?? fallbackDurationSec ?? 0}
        open={isOpen}
        onOpenChange={(open) => {
          // Track manual collapse during waiting so we don't re-open until waiting ends
          if (!open && (isLoading || shouldPoll) && !hasReasoningData) {
            userCollapsedWhileWaitingRef.current = true;
          }
          setIsOpen(open);
        }}
        // Only keep open by default when this specific chat is actively thinking (not completed)
        defaultOpen={
          !hasCompletedReasoning &&
          (isLoading ||
            withinPostWaitWindow ||
            (shouldPoll && !hasReasoningData))
        }
      >
        <ReasoningTrigger />
        <ReasoningContent>{combinedContent}</ReasoningContent>
      </Reasoning>
    </div>
  );
};

export default ChatReasoning;
