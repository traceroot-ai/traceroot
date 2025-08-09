import { NextResponse } from 'next/server';

interface WorkflowCheckbox {
    summarization: boolean;
    issue_creation: boolean;
    pr_creation: boolean;
}

interface GetWorkflowResponse {
    success: boolean;
    workflow?: WorkflowCheckbox;
    error?: string;
}

export async function GET(request: Request): Promise<NextResponse<GetWorkflowResponse>> {
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
                const apiUrl = `${restApiEndpoint}/v1/workflow`;
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

                const responseData = await response.json();

                return NextResponse.json({
                    success: true,
                    workflow: responseData.workflow,
                });
            } catch (apiError) {
                console.error('Error getting workflow from REST API:', apiError);
                return NextResponse.json(
                    {
                        success: false,
                        error: apiError instanceof Error ? apiError.message : 'Failed to get workflow from REST API'
                    },
                    { status: 500 }
                );
            }
        }

        // Fallback: Simulate successful workflow retrieval (for development/testing)
        console.log('No REST API endpoint specified, simulating successful workflow retrieval');

        return NextResponse.json({
            success: true,
            workflow: {
                summarization: false,
                issue_creation: false,
                pr_creation: false,
            },
        });
    } catch (error: unknown) {
        console.error('Error processing get workflow request:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to process get workflow request'
            },
            { status: 500 }
        );
    }
}
