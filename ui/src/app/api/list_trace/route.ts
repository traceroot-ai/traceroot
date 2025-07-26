import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Trace, TraceResponse } from '@/models/trace';

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
                // Construct the API URL
                const apiUrl = `${restApiEndpoint}/v1/explore/list-traces?start_time=${encodeURIComponent(startTimeValue)}&end_time=${encodeURIComponent(endTimeValue)}`;

                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userSecret}`,
                    },
                });

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
                console.error('Error fetching from REST API:', apiError);
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
