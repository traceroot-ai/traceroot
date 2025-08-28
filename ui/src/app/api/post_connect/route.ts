import { NextResponse } from "next/server";
import { TokenResource } from "@/models/integrate";

interface IntegrationSecretResponse {
  success: boolean;
  error?: string;
}

export async function POST(
  request: Request,
): Promise<NextResponse<IntegrationSecretResponse>> {
  try {
    // Extract user_secret from Authorization header
    console.log("Request headers:", request.headers);
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log(
        "Missing or invalid Authorization header. Expected: Bearer <user_secret>",
      );
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

    // Parse the request body to get TokenResource (without user_secret)
    const tokenResource: TokenResource = await request.json();

    // Check if REST_API_ENDPOINT environment variable is set
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      // Use REST API endpoint
      try {
        // Construct the API URL
        const apiUrl = `${restApiEndpoint}/v1/integrate`;
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user_secret}`,
          },
          body: JSON.stringify(tokenResource),
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
        console.error("Error posting to REST API:", apiError);
        return NextResponse.json(
          {
            success: false,
            error:
              apiError instanceof Error
                ? apiError.message
                : "Failed to post integration secret to REST API",
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
      token: tokenResource.token,
    });
  } catch (error: unknown) {
    console.error("Error processing integration secret request:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to process integration secret request",
      },
      { status: 500 },
    );
  }
}
