import { NextResponse } from "next/server";
import { ResourceType } from "@/models/integrate";

interface GetIntegrationResponse {
  success: boolean;
  token?: string | null;
  error?: string;
}

export async function GET(
  request: Request,
): Promise<NextResponse<GetIntegrationResponse>> {
  try {
    // Get user_secret from middleware-processed header
    const user_secret = request.headers.get("x-user-token") || "";

    // Parse query parameters from the URL
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

    // Check if REST_API_ENDPOINT environment variable is set
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      // Use REST API endpoint
      try {
        // Construct the API URL with query parameters
        const apiUrl = `${restApiEndpoint}/v1/integrate?resourceType=${encodeURIComponent(resourceType)}`;
        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user_secret}`,
          },
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

    // Fallback: Simulate successful integration (for development/testing)
    console.log(
      "No REST API endpoint specified, simulating successful integration",
    );

    return NextResponse.json({
      success: true,
      token: null, // No token found in fallback mode
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
