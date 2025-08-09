import { NextResponse } from 'next/server';

interface WorkflowRequest {
    checkbox_type: 'summarization' | 'issue_creation' | 'pr_creation';
}

interface WorkflowResponse {
    success: boolean;
    error?: string;
}

export async function POST(request: Request): Promise<NextResponse<WorkflowResponse>> {
    try {
        // Extract user_secret from Authorization header
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('Missing or invalid Authorization header. Expected: Bearer <user_secret>');
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing or invalid Authorization header. Expected: Bearer <user_secret>'
                },
                { status: 401 }
            );
        }

        const user_secret = authHeader.substring(7); // Remove 'Bearer ' prefix

        // Parse the request body to get checkbox_type
        const workflowRequest: WorkflowRequest = await request.json();

        // Check if REST_API_ENDPOINT environment variable is set
        const restApiEndpoint = process.env.REST_API_ENDPOINT;

        if (restApiEndpoint) {
            // Use REST API endpoint
            try {
                // Construct the API URL
                const apiUrl = `${restApiEndpoint}/v1/workflow`;
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${user_secret}`,
                    },
                    body: JSON.stringify(workflowRequest),
                });

                if (!response.ok) {
                    throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
                }

                const responseData = await response.json();

                return NextResponse.json({
                    success: true,
                });
            } catch (apiError) {
                console.error('Error posting workflow to REST API:', apiError);
                return NextResponse.json(
                    {
                        success: false,
                        error: apiError instanceof Error ? apiError.message : 'Failed to post workflow to REST API'
                    },
                    { status: 500 }
                );
            }
        }

        // Fallback: Simulate successful workflow enable (for development/testing)
        console.log('No REST API endpoint specified, simulating successful workflow enable');

        return NextResponse.json({
            success: true,
        });
    } catch (error: unknown) {
        console.error('Error processing workflow enable request:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to process workflow enable request'
            },
            { status: 500 }
        );
    }
}
