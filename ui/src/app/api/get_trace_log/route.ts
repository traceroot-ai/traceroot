import { NextResponse } from "next/server";
import { TraceLog } from "@/models/log";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

const FETCH_TIMEOUT = 90000; // 90 seconds

export interface LogResponse {
  success: boolean;
  data: TraceLog | null;
  error?: string;
}

async function fetchLogsFromRestAPI(
  traceId: string,
  startTime: string | null,
  endTime: string | null,
  logGroupName?: string,
  traceProvider?: string,
  traceRegion?: string,
  logProvider?: string,
  logRegion?: string,
): Promise<TraceLog | null> {
  const restApiEndpoint = process.env.REST_API_ENDPOINT;

  if (!restApiEndpoint) {
    throw new Error("REST_API_ENDPOINT environment variable is not set");
  }

  const url = new URL(`${restApiEndpoint}/v1/explore/get-logs-by-trace-id`);
  url.searchParams.append("trace_id", traceId);

  // Only add timestamps if provided
  if (startTime) {
    url.searchParams.append("start_time", startTime);
  }
  if (endTime) {
    url.searchParams.append("end_time", endTime);
  }

  if (logGroupName) {
    url.searchParams.append("log_group_name", logGroupName);
  }

  // Add provider parameters if provided
  if (traceProvider) {
    url.searchParams.append("trace_provider", traceProvider);
  }
  if (traceRegion) {
    url.searchParams.append("trace_region", traceRegion);
  }
  if (logProvider) {
    url.searchParams.append("log_provider", logProvider);
  }
  if (logRegion) {
    url.searchParams.append("log_region", logRegion);
  }

  // Get auth headers (automatically uses Clerk's auth() and currentUser())
  const headers = await createBackendAuthHeaders();

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  const response = await fetch(url.toString(), {
    headers,
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(
      `REST API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const apiResponse = await response.json();

  // Transform REST API response to match our TraceLog format
  if (apiResponse.logs && apiResponse.logs.logs) {
    const traceLog: TraceLog = {
      [traceId]: apiResponse.logs.logs,
    };
    return traceLog;
  }

  return null;
}

export async function GET(
  request: Request,
): Promise<NextResponse<LogResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const traceId = searchParams.get("traceId");
    const startTime = searchParams.get("start_time");
    const endTime = searchParams.get("end_time");
    const logGroupNameParam = searchParams.get("log_group_name");
    // Convert null to undefined for the optional parameter
    const logGroupName = logGroupNameParam ?? undefined;

    // Get provider information
    const traceProvider = searchParams.get("trace_provider") ?? undefined;
    const traceRegion = searchParams.get("trace_region") ?? undefined;
    const logProvider = searchParams.get("log_provider") ?? undefined;
    const logRegion = searchParams.get("log_region") ?? undefined;

    if (!traceId) {
      return NextResponse.json(
        {
          success: false,
          data: null,
          error: "Trace ID is required",
        },
        { status: 400 },
      );
    }

    // Start time and end time are now optional when searching by trace_id
    // If not provided, backend will search without time constraints

    let logData: TraceLog | null = null;

    logData = await fetchLogsFromRestAPI(
      traceId,
      startTime,
      endTime,
      logGroupName,
      traceProvider,
      traceRegion,
      logProvider,
      logRegion,
    );

    return NextResponse.json({
      success: true,
      data: logData,
    });
  } catch (error: unknown) {
    console.error("Error fetching log data:", error);
    return NextResponse.json(
      {
        success: false,
        data: null,
        error:
          error instanceof Error ? error.message : "Failed to fetch log data",
      },
      { status: 500 },
    );
  }
}
