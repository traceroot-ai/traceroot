import { NextResponse } from "next/server";
import { TokenResource } from "@/models/integrate";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

interface IntegrationSecretResponse {
  success: boolean;
  error?: string;
}

export async function POST(
  request: Request,
): Promise<NextResponse<IntegrationSecretResponse>> {
  const requestId = Math.random().toString(36).substring(7);
  console.log(
    `[${requestId}] POST /api/post_connect - Starting request processing`,
  );

  try {
    // Parse the request body to get TokenResource
    const tokenResource: TokenResource = await request.json();
    console.log(`[${requestId}] Parsed token resource:`, {
      token: tokenResource.token
        ? `${tokenResource.token.substring(0, 10)}...`
        : "undefined",
      hasToken: !!tokenResource.token,
      tokenLength: tokenResource.token?.length || 0,
    });

    const restApiEndpoint = process.env.REST_API_ENDPOINT;
    console.log(
      `[${requestId}] REST API endpoint configured: ${restApiEndpoint ? "Yes" : "No"}`,
    );

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/integrate`;
        console.log(`[${requestId}] Making API call to: ${apiUrl}`);

        const response = await fetch(apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(tokenResource),
        });

        console.log(
          `[${requestId}] API response status: ${response.status} ${response.statusText}`,
        );

        if (!response.ok) {
          console.error(
            `[${requestId}] API request failed with status: ${response.status}`,
          );
          const errorText = await response.text();
          console.error(`[${requestId}] API error response:`, errorText);
          throw new Error(
            `REST API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const responseData = await response.json();
        console.log(`[${requestId}] API response data:`, {
          success: responseData.success,
          hasToken: !!responseData.token,
          tokenLength: responseData.token?.length || 0,
        });

        console.log(`[${requestId}] Returning successful response`);
        return NextResponse.json({
          success: true,
          token: responseData.token,
        });
      } catch (apiError) {
        console.error(`[${requestId}] Error posting to REST API:`, apiError);
        console.error(`[${requestId}] API error details:`, {
          name: apiError instanceof Error ? apiError.name : "Unknown",
          message:
            apiError instanceof Error ? apiError.message : String(apiError),
          stack: apiError instanceof Error ? apiError.stack : undefined,
        });
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
      `[${requestId}] No REST API endpoint specified, simulating successful integration`,
    );
    console.log(`[${requestId}] Fallback response:`, {
      success: true,
      token: tokenResource.token
        ? `${tokenResource.token.substring(0, 10)}...`
        : "undefined",
    });

    return NextResponse.json({
      success: true,
      token: tokenResource.token,
    });
  } catch (error: unknown) {
    console.error(
      `[${requestId}] Error processing integration secret request:`,
      error,
    );
    console.error(`[${requestId}] Error details:`, {
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
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
