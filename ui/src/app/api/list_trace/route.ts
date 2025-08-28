import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Trace, TraceResponse } from '@/models/trace';

const FETCH_TIMEOUT = 30000; // 30 seconds

export async function GET(request: Request): Promise<NextResponse<TraceResponse>> {
    try {
        // Extract user_secret from Authorization header
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json({
                success: false,
                data: [],
                error: 'Missing or invalid Authorization header. Expected: Bearer <user_secret>'
            }, { status: 401 });
        }

        const userSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

        // Get URL parameters
        const { searchParams } = new URL(request.url);
        const startTime = searchParams.get('startTime');
        const endTime = searchParams.get('endTime');
        const categories = searchParams.getAll('categories');
        const values = searchParams.getAll('values');
        const operations = searchParams.getAll('operations');

        // Check if REST_API_ENDPOINT environment variable is set
        const restApiEndpoint = process.env.REST_API_ENDPOINT;

        if (restApiEndpoint) {
            // Use REST API endpoint
            try {
                // Generate default timestamps if not provided (last 3 hours)
                const now = new Date();
                const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

                // Ensure start and end times are provided
                if (!startTime || !endTime) {
                    console.log('Start or end time not provided, using default values (last 3 hours)');
                }

                const startTimeValue = startTime || threeHoursAgo.toISOString();
                const endTimeValue = endTime || now.toISOString();

                // Construct the API URL with categories and values
                let apiUrl = `${restApiEndpoint}/v1/explore/list-traces?start_time=${encodeURIComponent(startTimeValue)}&end_time=${encodeURIComponent(endTimeValue)}`;

                // TODO: improve this
                // Add categories, values, and operations parameters if provided
                if (categories.length > 0) {
                    categories.forEach(category => {
                        apiUrl += `&categories=${encodeURIComponent(category)}`;
                    });
                }

                if (values.length > 0) {
                    values.forEach(value => {
                        apiUrl += `&values=${encodeURIComponent(value)}`;
                    });
                }

                if (operations.length > 0) {
                    operations.forEach(operation => {
                        apiUrl += `&operations=${encodeURIComponent(operation)}`;
                    });
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userSecret}`,
                    },
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
                }

                const pythonResponse: { traces: Trace[] } = await response.json();

                // The Python dataclass structure is already compatible with TypeScript Trace interface
                const traces: Trace[] = pythonResponse.traces;

                return NextResponse.json({
                    success: true,
                    data: traces
                });
            } catch (apiError) {
                const errorMessage = apiError instanceof Error ? apiError.message : 'Unknown error';

                if (apiError instanceof Error && apiError.name === 'AbortError') {
                    console.error('REST API request timed out after 30 seconds');
                } else {
                    console.error('Error fetching from REST API:', errorMessage);
                }

                // Fall back to file-based approach if REST API fails
                console.log('Falling back to file-based trace data');
            }
        }

        // Fallback: Simulate getting the trace data from local files
        const traceDir: string = path.join(process.cwd(), 'data/trace');
        const files: string[] = fs.readdirSync(traceDir)
            .filter((file: string): boolean => file.endsWith('.json'))
            .sort();
        const traces: Trace[] = files.map((file: string): Trace => {
            const filePath: string = path.join(traceDir, file);
            const fileContent: string = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(fileContent) as Trace;
        });

        return NextResponse.json({
            success: true,
            data: traces
        });
    } catch (error: unknown) {
        console.error('Error reading trace files:', error);
        return NextResponse.json(
            {
                success: false,
                data: [],
                error: error instanceof Error ? error.message : 'Failed to read trace data'
            },
            { status: 500 }
        );
    }
}
