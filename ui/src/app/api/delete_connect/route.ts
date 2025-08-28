import { NextResponse } from "next/server";

interface DeleteIntegrationRequest {
  resource_type: string;
}

interface DeleteIntegrationResponse {
  success: boolean;
  error?: string;
}

export async function DELETE(
  request: Request,
): Promise<NextResponse<DeleteIntegrationResponse>> {
  try {
    // Extract user_secret from Authorization header
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Missing or invalid Authorization header. Expected: Bearer <user_secret>",
        },
        { status: 401 },
      );
    }

    const user_secret = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Parse the request body to get resource_type
    const { resource_type }: DeleteIntegrationRequest = await request.json();

    // Check if REST_API_ENDPOINT environment variable is set
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      // Use REST API endpoint
      try {
        // Construct the API URL
        const apiUrl = `${restApiEndpoint}/v1/integrate`;
        const response = await fetch(apiUrl, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user_secret}`,
          },
          body: JSON.stringify({ resource_type }),
        });

        if (!response.ok) {
          throw new Error(
            `REST API request failed: ${response.status} ${response.statusText}`,
          );
        }

        return NextResponse.json({
          success: true,
        });
      } catch (apiError) {
        console.error("Error deleting via REST API:", apiError);
        return NextResponse.json(
          {
            success: false,
            error:
              apiError instanceof Error
                ? apiError.message
                : "Failed to delete integration via REST API",
          },
          { status: 500 },
        );
      }
    }

    // Fallback: Simulate successful deletion (for development/testing)
    console.log(
      "No REST API endpoint specified, simulating successful deletion",
    );

    return NextResponse.json({
      success: true,
    });
  } catch (error: unknown) {
    console.error("Error processing delete integration request:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to process delete integration request",
      },
      { status: 500 },
    );
  }
}
