import { NextResponse } from "next/server";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

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
    // Parse the request body to get resource_type
    const { resource_type }: DeleteIntegrationRequest = await request.json();

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/integrate`;

        const response = await fetch(apiUrl, {
          method: "DELETE",
          headers,
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
