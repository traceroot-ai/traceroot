import { NextResponse } from "next/server";
import {
  GetChatMetadataHistoryRequest,
  ChatMetadataHistory,
} from "@/models/chat";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

export async function GET(
  request: Request,
): Promise<NextResponse<ChatMetadataHistory>> {
  try {
    const url = new URL(request.url);
    const trace_id = url.searchParams.get("trace_id");
    const limit = url.searchParams.get("limit") || "5";
    const skip = url.searchParams.get("skip") || "0";

    if (!trace_id) {
      return NextResponse.json(
        { history: [], hasMore: false } as ChatMetadataHistory,
        {
          status: 400,
        },
      );
    }

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/explore/get-chat-metadata-history?trace_id=${encodeURIComponent(trace_id)}&limit=${limit}&skip=${skip}`;
        const apiResponse = await fetch(apiUrl, {
          method: "GET",
          headers,
        });

        if (!apiResponse.ok) {
          throw new Error(
            `REST API call failed with status: ${apiResponse.status}`,
          );
        }

        const apiData: ChatMetadataHistory = await apiResponse.json();

        // Convert timestamp from Python datetime string to number for consistency
        const processedData: ChatMetadataHistory = {
          history: apiData.history.map((item) => ({
            ...item,
            timestamp:
              typeof item.timestamp === "string"
                ? new Date(item.timestamp).getTime()
                : item.timestamp,
          })),
          hasMore: apiData.hasMore,
        };

        return NextResponse.json(processedData);
      } catch (apiError) {
        console.error("REST API call failed:", apiError);
        // Fall back to empty response if REST API fails
        console.log("Falling back to empty response due to API error");
      }
    }

    // Fallback to empty response when REST_API_ENDPOINT is not set or API call fails
    const fallbackResponse: ChatMetadataHistory = {
      history: [],
      hasMore: false,
    };

    return NextResponse.json(fallbackResponse);
  } catch (error) {
    console.error("Get Chat Metadata History API Error:", error);

    const errorResponse: ChatMetadataHistory = {
      history: [],
      hasMore: false,
    };

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
