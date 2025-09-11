import { NextResponse } from "next/server";
import { GetChatHistoryRequest, ChatHistoryResponse } from "@/models/chat";

export async function GET(
  request: Request,
): Promise<NextResponse<ChatHistoryResponse | null>> {
  try {
    const url = new URL(request.url);
    const chat_id = url.searchParams.get("chat_id");

    if (!chat_id) {
      return NextResponse.json(null, { status: 400 });
    }

    // Extract user_secret from Authorization header
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(null, { status: 401 });
    }

    const userSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        const apiUrl = `${restApiEndpoint}/v1/explore/get-chat-history?chat_id=${encodeURIComponent(chat_id)}`;
        const apiResponse = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userSecret}`,
          },
        });

        if (!apiResponse.ok) {
          throw new Error(
            `REST API call failed with status: ${apiResponse.status}`,
          );
        }

        const apiData: ChatHistoryResponse = await apiResponse.json();

        // Convert timestamp from Python datetime string to number for consistency
        const processedData: ChatHistoryResponse = {
          ...apiData,
          history: apiData.history.map((item) => ({
            ...item,
            time:
              typeof item.time === "string"
                ? new Date(item.time).getTime()
                : item.time,
          })),
        };

        return NextResponse.json(processedData);
      } catch (apiError) {
        console.error("REST API call failed:", apiError);
        // Fall back to null response if REST API fails
        console.log("Falling back to null response due to API error");
      }
    }

    // Fallback to null response when REST_API_ENDPOINT is not set or API call fails
    return NextResponse.json(null);
  } catch (error) {
    console.error("Get Chat History API Error:", error);

    return NextResponse.json(null, { status: 500 });
  }
}
