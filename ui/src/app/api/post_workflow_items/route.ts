import { NextResponse } from 'next/server';

interface PostWorkflowItemRequest {
    trace_id: string;
    service_name: string;
    error_count: number;
    summarization?: string;
    created_issue?: string;
    created_pr?: string;
    pattern: {
        pattern_id: string;
        pattern_description: string;
    };
    timestamp: string;
}

interface PostWorkflowItemResponse {
    success: boolean;
    error?: string;
}

export async function POST(request: Request): Promise<NextResponse<PostWorkflowItemResponse>> {
    try {
        // Extract user_secret from Authorization header
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing or invalid Authorization header. Expected: Bearer <user_secret>'
                },
                { status: 401 }
            );
        }

        const user_secret = authHeader.substring(7); // Remove 'Bearer ' prefix

        // Parse the request body
        const workflowItemData: PostWorkflowItemRequest = await request.json();

        // Validate required fields
        if (!workflowItemData.trace_id || !workflowItemData.service_name || !workflowItemData.pattern) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing required fields: trace_id, service_name, and pattern are required'
                },
                { status: 400 }
            );
        }

        // Check if REST_API_ENDPOINT environment variable is set
        const restApiEndpoint = process.env.REST_API_ENDPOINT;

        if (restApiEndpoint) {
            // Use REST API endpoint
            try {
                // Construct the API URL
                const apiUrl = `${restApiEndpoint}/v1/workflow/items`;
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${user_secret}`,
                    },
                    body: JSON.stringify(workflowItemData),
                });

                if (!response.ok) {
                    throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
                }

                return NextResponse.json({
                    success: true,
                });
            } catch (apiError) {
                console.error('Error creating workflow item via REST API:', apiError);
                return NextResponse.json(
                    {
                        success: false,
                        error: apiError instanceof Error ? apiError.message : 'Failed to create workflow item via REST API'
                    },
                    { status: 500 }
                );
            }
        }

        // Fallback: Simulate successful creation (for development/testing)
        console.log('No REST API endpoint specified, simulating successful workflow item creation');

        return NextResponse.json({
            success: true,
        });
    } catch (error: unknown) {
        console.error('Error processing post workflow item request:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to process post workflow item request'
            },
            { status: 500 }
        );
    }
}
