import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { TraceLog } from "@/models/log";
import { appendProviderParams } from "@/utils/provider";

export interface LogResponse {
  success: boolean;
  data: TraceLog | null;
  error?: string;
}

async function fetchLogsFromRestAPI(
  traceId: string,
  startTime: string,
  endTime: string,
  userSecret: string,
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
  url.searchParams.append("start_time", startTime);
  url.searchParams.append("end_time", endTime);

  if (logGroupName) {
    url.searchParams.append("log_group_name", logGroupName);
  }

  // Add provider information (required providers, optional regions)
  appendProviderParams(url, traceProvider, traceRegion, logProvider, logRegion);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${userSecret}`,
    },
  });

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

async function fetchLogsFromFiles(traceId: string): Promise<TraceLog | null> {
  // Read all log files and find the one containing the requested trace ID
  const logDir: string = path.join(process.cwd(), "data/log");

  if (!fs.existsSync(logDir)) {
    return null;
  }

  const files: string[] = fs
    .readdirSync(logDir)
    .filter((file: string): boolean => file.endsWith(".json"))
    .sort();

  for (const file of files) {
    const filePath: string = path.join(logDir, file);
    const fileContent: string = fs.readFileSync(filePath, "utf-8");
    const logData: TraceLog = JSON.parse(fileContent);

    if (logData[traceId]) {
      return { [traceId]: logData[traceId] };
    }
  }

  return null;
}

export async function GET(
  request: Request,
): Promise<NextResponse<LogResponse>> {
  try {
    // Get user_secret from middleware-processed header
    const userSecret = request.headers.get("x-user-token") || "";

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

    if (!startTime || !endTime) {
      return NextResponse.json(
        {
          success: false,
          data: null,
          error: "Start time and end time are required",
        },
        { status: 400 },
      );
    }

    let logData: TraceLog | null = null;

    // Check if REST_API_ENDPOINT is configured
    if (process.env.REST_API_ENDPOINT) {
      // Use REST API
      logData = await fetchLogsFromRestAPI(
        traceId,
        startTime,
        endTime,
        userSecret,
        logGroupName,
        traceProvider,
        traceRegion,
        logProvider,
        logRegion,
      );
    } else {
      // Use file-based approach
      logData = await fetchLogsFromFiles(traceId);
    }

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
