import { NextResponse } from "next/server";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

interface ReasoningData {
  chunk_id: number;
  content: string;
  status: string;
  timestamp: string;
  trace_id?: string;
}

interface ReasoningResponse {
  chat_id: string;
  reasoning: ReasoningData[];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ chat_id: string }> },
): Promise<NextResponse<ReasoningResponse | null>> {
  try {
    const { chat_id } = await params;

    if (!chat_id) {
      return NextResponse.json(null, { status: 400 });
    }

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/explore/chat/${encodeURIComponent(chat_id)}/reasoning`;
        const apiResponse = await fetch(apiUrl, {
          method: "GET",
          headers,
        });

        if (!apiResponse.ok) {
          if (apiResponse.status === 404) {
            // Return empty reasoning data for 404 instead of null
            return NextResponse.json({
              chat_id,
              reasoning: [],
            });
          }
          throw new Error(
            `REST API call failed with status: ${apiResponse.status}`,
          );
        }

        const apiData: ReasoningResponse = await apiResponse.json();
        return NextResponse.json(apiData);
      } catch (apiError) {
        console.error("REST API call failed:", apiError);
        // Fall back to empty reasoning response if REST API fails
        return NextResponse.json({
          chat_id,
          reasoning: [],
        });
      }
    }

    // Fallback to empty reasoning response when REST_API_ENDPOINT is not set
    return NextResponse.json({
      chat_id,
      reasoning: [],
    });
  } catch (error) {
    console.error("Get Chat Reasoning API Error:", error);
    return NextResponse.json(null, { status: 500 });
  }
}
