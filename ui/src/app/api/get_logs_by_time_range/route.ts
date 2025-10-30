import { NextResponse } from "next/server";
import { TraceLogs } from "@/models/log";
import { createBackendAuthHeaders } from "@/lib/auth/server";

export interface LogsByTimeRangeResponse {
  success: boolean;
  logs: TraceLogs | null;
  has_more?: boolean;
  next_pagination_token?: string | null;
  error?: string;
}

async function fetchLogsFromRestAPI(
  startTime: string,
  endTime: string,
  logSearchTerm: string | null,
  paginationToken: string | null,
  logProvider?: string,
  logRegion?: string,
): Promise<{
  logs: TraceLogs | null;
  has_more: boolean;
  next_pagination_token: string | null;
}> {
  const restApiEndpoint = process.env.REST_API_ENDPOINT;

  if (!restApiEndpoint) {
    throw new Error("REST_API_ENDPOINT environment variable is not set");
  }

  const url = new URL(`${restApiEndpoint}/v1/explore/get-logs-by-time-range`);
  url.searchParams.append("start_time", startTime);
  url.searchParams.append("end_time", endTime);

  if (logSearchTerm) {
    url.searchParams.append("log_search_term", logSearchTerm);
  }

  if (paginationToken) {
    url.searchParams.append("pagination_token", paginationToken);
  }

  // Add provider parameters if provided
  if (logProvider) {
    url.searchParams.append("log_provider", logProvider);
  }
  if (logRegion) {
    url.searchParams.append("log_region", logRegion);
  }

  // Get auth headers (automatically uses Clerk's auth() and currentUser())
  const headers = await createBackendAuthHeaders();
  const response = await fetch(url.toString(), {
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `REST API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const apiResponse = await response.json();

  // Return the full response including pagination info
  return {
    logs: apiResponse.logs || null,
    has_more: apiResponse.has_more || false,
    next_pagination_token: apiResponse.next_pagination_token || null,
  };
}

export async function GET(
  request: Request,
): Promise<NextResponse<LogsByTimeRangeResponse>> {
  try {
    const { searchParams } = new URL(request.url);
    const startTime = searchParams.get("start_time");
    const endTime = searchParams.get("end_time");
    const logSearchTerm = searchParams.get("log_search_term");
    const paginationToken = searchParams.get("pagination_token");

    // Get provider information
    const logProvider = searchParams.get("log_provider") ?? undefined;
    const logRegion = searchParams.get("log_region") ?? undefined;

    if (!startTime || !endTime) {
      return NextResponse.json(
        {
          success: false,
          logs: null,
          error: "Start time and end time are required",
        },
        { status: 400 },
      );
    }

    let logData: TraceLogs | null = null;
    let hasMore = false;
    let nextPaginationToken: string | null = null;

    // Check if REST_API_ENDPOINT is configured
    if (process.env.REST_API_ENDPOINT) {
      // Use REST API
      const result = await fetchLogsFromRestAPI(
        startTime,
        endTime,
        logSearchTerm,
        paginationToken,
        logProvider,
        logRegion,
      );
      logData = result.logs;
      hasMore = result.has_more;
      nextPaginationToken = result.next_pagination_token;
    } else {
      // Return empty logs if no REST API endpoint configured
      logData = { logs: [] };
    }

    return NextResponse.json({
      success: true,
      logs: logData,
      has_more: hasMore,
      next_pagination_token: nextPaginationToken,
    });
  } catch (error: unknown) {
    console.error("Error fetching logs by time range:", error);
    return NextResponse.json(
      {
        success: false,
        logs: null,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch logs by time range",
      },
      { status: 500 },
    );
  }
}
