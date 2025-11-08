"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/nextjs";
import { TraceLog } from "@/models/log";
import { Trace as TraceModel } from "@/models/trace";
import { initializeProviders, appendProviderParams } from "@/utils/provider";

interface UseLogsOptions {
  traceIds: string[];
  allTraces?: TraceModel[];
  enabled?: boolean;
}

async function fetchLogs(
  traceIds: string[],
  allTraces: TraceModel[],
  getToken: () => Promise<string | null>,
): Promise<TraceLog> {
  if (!traceIds || traceIds.length === 0) {
    return {};
  }

  const { traceProvider, logProvider, traceRegion, logRegion } =
    initializeProviders();
  const token = await getToken();

  // Fetch logs for all traces in parallel
  type FetchResult =
    | { traceId: string; data: TraceLog; success: true }
    | { traceId: string; data: null; success: false; error: string };

  const fetchPromises = traceIds.map(async (traceId): Promise<FetchResult> => {
    try {
      const url = new URL("/api/get_trace_log", window.location.origin);
      url.searchParams.append("traceId", traceId);

      // Find the trace in allTraces to get its timestamps
      const trace = allTraces.find((t) => t.id === traceId);
      if (
        trace &&
        trace.start_time &&
        trace.end_time &&
        trace.start_time !== 0
      ) {
        const startTime = new Date(trace.start_time * 1000).toISOString();
        const endTime = new Date(trace.end_time * 1000).toISOString();
        url.searchParams.append("start_time", startTime);
        url.searchParams.append("end_time", endTime);
      }

      appendProviderParams(
        url,
        traceProvider,
        traceRegion,
        logProvider,
        logRegion,
      );

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Failed to fetch logs");
      }

      return { traceId, data: result.data as TraceLog, success: true };
    } catch (err) {
      console.error(`useLogs fetchLogs - error for ${traceId}:`, err);
      return {
        traceId,
        data: null,
        success: false,
        error:
          err instanceof Error
            ? err.message
            : "An error occurred while fetching logs",
      };
    }
  });

  const results = await Promise.all(fetchPromises);

  // Merge all successful results
  const mergedLogs: TraceLog = {};
  let hasErrors = false;
  let errorMessage = "";

  results.forEach((result) => {
    if (result.success && result.data) {
      Object.entries(result.data).forEach(([traceId, spanLogs]) => {
        mergedLogs[traceId] = spanLogs;
      });
    } else {
      hasErrors = true;
      errorMessage = result.error || "Failed to fetch logs for some traces";
    }
  });

  if (hasErrors && Object.keys(mergedLogs).length === 0) {
    throw new Error(errorMessage);
  }

  return mergedLogs;
}

export function useLogs({
  traceIds,
  allTraces = [],
  enabled = true,
}: UseLogsOptions) {
  const { getToken } = useAuth();

  return useQuery({
    queryKey: [
      "logs",
      traceIds,
      allTraces.map((t) => ({ id: t.id, start: t.start_time })),
    ],
    queryFn: () => fetchLogs(traceIds, allTraces, getToken),
    enabled: enabled && traceIds.length > 0,
  });
}
