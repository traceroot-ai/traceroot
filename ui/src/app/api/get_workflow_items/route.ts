import { NextResponse } from 'next/server';

interface WorkflowItem {
    trace_id: string;
    service_name: string;
    error_count: number;
    summarization: string;
    created_issue: string;
    created_pr: string;
    pattern: {
        pattern_id: string;
        pattern_description: string;
    };
    timestamp: string;
}

interface GetWorkflowItemsResponse {
    success: boolean;
    workflow_items?: WorkflowItem[];
    error?: string;
}

export async function GET(request: Request): Promise<NextResponse<GetWorkflowItemsResponse>> {
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

        // Check if REST_API_ENDPOINT environment variable is set
        const restApiEndpoint = process.env.REST_API_ENDPOINT;

        if (restApiEndpoint) {
            // Use REST API endpoint
            try {
                // Construct the API URL
                    const apiUrl = `${restApiEndpoint}/v1/workflow/items`;
                const response = await fetch(apiUrl, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${user_secret}`,
                    },
                });

                if (!response.ok) {
                    throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                return NextResponse.json({
                    success: true,
                    workflow_items: data.workflow_items || []
                });
            } catch (apiError) {
                console.error('Error fetching workflow items via REST API:', apiError);
                return NextResponse.json(
                    {
                        success: false,
                        error: apiError instanceof Error ? apiError.message : 'Failed to fetch workflow items via REST API'
                    },
                    { status: 500 }
                );
            }
        }

        // Fallback: Return empty array for development/testing
        console.log('No REST API endpoint specified, returning empty workflow items array');

        return NextResponse.json({
            success: true,
            workflow_items: []
        });
    } catch (error: unknown) {
        console.error('Error processing get workflow items request:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to process get workflow items request'
            },
            { status: 500 }
        );
    }
}
