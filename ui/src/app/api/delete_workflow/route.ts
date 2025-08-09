import { NextResponse } from 'next/server';

interface DeleteWorkflowRequest {
    checkbox_type: 'summarization' | 'issue_creation' | 'pr_creation';
}

interface DeleteWorkflowResponse {
    success: boolean;
    error?: string;
}

export async function DELETE(request: Request): Promise<NextResponse<DeleteWorkflowResponse>> {
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

        // Parse the request body to get checkbox_type
        const { checkbox_type }: DeleteWorkflowRequest = await request.json();

        // Check if REST_API_ENDPOINT environment variable is set
        const restApiEndpoint = process.env.REST_API_ENDPOINT;

        if (restApiEndpoint) {
            // Use REST API endpoint
            try {
                // Construct the API URL
                const apiUrl = `${restApiEndpoint}/v1/workflow`;
                const response = await fetch(apiUrl, {
                    method: 'DELETE',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${user_secret}`,
                    },
                    body: JSON.stringify({ checkbox_type }),
                });

                if (!response.ok) {
                    throw new Error(`REST API request failed: ${response.status} ${response.statusText}`);
                }

                return NextResponse.json({
                    success: true,
                });
            } catch (apiError) {
                console.error('Error deleting workflow via REST API:', apiError);
                return NextResponse.json(
                    {
                        success: false,
                        error: apiError instanceof Error ? apiError.message : 'Failed to delete workflow via REST API'
                    },
                    { status: 500 }
                );
            }
        }

        // Fallback: Simulate successful deletion (for development/testing)
        console.log('No REST API endpoint specified, simulating successful workflow deletion');

        return NextResponse.json({
            success: true,
        });
    } catch (error: unknown) {
        console.error('Error processing delete workflow request:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to process delete workflow request'
            },
            { status: 500 }
        );
    }
}
