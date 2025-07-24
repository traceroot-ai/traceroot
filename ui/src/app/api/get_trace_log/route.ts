import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { TraceLog } from '@/models/log';

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
    logGroupName?: string
): Promise<TraceLog | null> {
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (!restApiEndpoint) {
        throw new Error('REST_API_ENDPOINT environment variable is not set');
    }

    const url = new URL(`${restApiEndpoint}/v1/explore/get-logs-by-trace-id`);
    url.searchParams.append('trace_id', traceId);
    url.searchParams.append('start_time', startTime);
    url.searchParams.append('end_time', endTime);

    if (logGroupName) {
        url.searchParams.append('log_group_name', logGroupName);
    }

    const response = await fetch(url.toString(), {
        headers: {
            'Authorization': `Bearer ${userSecret}`,
        },
    });

    if (!response.ok) {
        throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
    }

    const apiResponse = await response.json();

    // Transform REST API response to match our TraceLog format
    if (apiResponse.logs && apiResponse.logs.logs) {
        const traceLog: TraceLog = {
            [traceId]: apiResponse.logs.logs
        };
        return traceLog;
    }

    return null;
}

async function fetchLogsFromFiles(traceId: string): Promise<TraceLog | null> {
    // Read all log files and find the one containing the requested trace ID
    const logDir: string = path.join(process.cwd(), 'data/log');

    if (!fs.existsSync(logDir)) {
        return null;
    }

    const files: string[] = fs.readdirSync(logDir)
        .filter((file: string): boolean => file.endsWith('.json'))
        .sort();

    for (const file of files) {
        const filePath: string = path.join(logDir, file);
        const fileContent: string = fs.readFileSync(filePath, 'utf-8');
        const logData: TraceLog = JSON.parse(fileContent);

        if (logData[traceId]) {
            return { [traceId]: logData[traceId] };
        }
    }

    return null;
}

export async function GET(request: Request): Promise<NextResponse<LogResponse>> {
    try {
        // Extract user_secret from Authorization header
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({
                success: false,
                data: null,
                error: 'Missing or invalid Authorization header. Expected: Bearer <user_secret>'
            }, { status: 401 });
        }

        const userSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

        const { searchParams } = new URL(request.url);
        const traceId = searchParams.get('traceId');
        const startTime = searchParams.get('start_time');
        const endTime = searchParams.get('end_time');
        const logGroupNameParam = searchParams.get('log_group_name');
        // Convert null to undefined for the optional parameter
        const logGroupName = logGroupNameParam ?? undefined;

        if (!traceId) {
            return NextResponse.json({
                success: false,
                data: null,
                error: 'Trace ID is required'
            }, { status: 400 });
        }

        if (!startTime || !endTime) {
            return NextResponse.json({
                success: false,
                data: null,
                error: 'Start time and end time are required'
            }, { status: 400 });
        }

        let logData: TraceLog | null = null;

        // Check if REST_API_ENDPOINT is configured
        if (process.env.REST_API_ENDPOINT) {
            // Use REST API
            logData = await fetchLogsFromRestAPI(traceId, startTime, endTime, userSecret, logGroupName);
        } else {
            // Use file-based approach
            logData = await fetchLogsFromFiles(traceId);
        }

        return NextResponse.json({
            success: true,
            data: logData
        });

    } catch (error: unknown) {
        console.error('Error fetching log data:', error);
        return NextResponse.json(
            {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to fetch log data'
            },
            { status: 500 }
        );
    }
}
