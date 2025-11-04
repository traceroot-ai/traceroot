import { NextResponse } from "next/server";
import {
  ConfirmGitHubActionRequest,
  ConfirmGitHubActionResponse,
} from "@/models/chat";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

export async function POST(
  request: Request,
): Promise<NextResponse<ConfirmGitHubActionResponse>> {
  try {
    const body: ConfirmGitHubActionRequest = await request.json();
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (!restApiEndpoint) {
      throw new Error("REST_API_ENDPOINT is not configured");
    }

    const apiUrl = `${restApiEndpoint}/v1/explore/confirm-github-action`;

    // Get auth headers (automatically uses Clerk's auth() and currentUser())
    const headers = await createBackendAuthHeaders();
    const apiResponse = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      throw new Error(
        `REST API call failed with status: ${apiResponse.status}. ${errorText}`,
      );
    }

    const apiData: ConfirmGitHubActionResponse = await apiResponse.json();

    return NextResponse.json(apiData);
  } catch (error) {
    console.error("Confirm GitHub Action API Error:", error);

    const errorResponse: ConfirmGitHubActionResponse = {
      success: false,
      message:
        error instanceof Error
          ? error.message
          : "Failed to process confirmation",
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
