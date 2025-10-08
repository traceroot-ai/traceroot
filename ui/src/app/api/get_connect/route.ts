import { NextResponse } from "next/server";
import { ResourceType } from "@/models/integrate";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

interface GetIntegrationResponse {
  success: boolean;
  token?: string | null;
  error?: string;
}

/**
 * GET /api/get_connect
 * Fetches integration tokens for a specific resource type
 */
export async function GET(
  request: Request,
): Promise<NextResponse<GetIntegrationResponse>> {
  try {
    const url = new URL(request.url);
    const resourceType = url.searchParams.get("resourceType") as ResourceType;

    if (!resourceType) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required parameter: resourceType",
        },
        { status: 400 },
      );
    }

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/integrate?resourceType=${encodeURIComponent(resourceType)}`;
        const response = await fetch(apiUrl, {
          method: "GET",
          headers,
        });

        if (!response.ok) {
          throw new Error(
            `REST API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const responseData = await response.json();

        return NextResponse.json({
          success: true,
          token: responseData.token,
        });
      } catch (apiError) {
        console.error("Error getting from REST API:", apiError);
        return NextResponse.json(
          {
            success: false,
            error:
              apiError instanceof Error
                ? apiError.message
                : "Failed to get integration from REST API",
          },
          { status: 500 },
        );
      }
    }

    // Fallback: No REST API endpoint configured
    return NextResponse.json({
      success: true,
      token: null,
    });
  } catch (error: unknown) {
    console.error("Error processing get integration request:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to process get integration request",
      },
      { status: 500 },
    );
  }
}
