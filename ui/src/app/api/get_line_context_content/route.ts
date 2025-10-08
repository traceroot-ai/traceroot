import { NextResponse } from "next/server";
import { CodeResponse } from "../../../models/code";
import { createBackendAuthHeaders } from "@/lib/server-auth-headers";

export async function GET(
  request: Request,
): Promise<NextResponse<CodeResponse | null>> {
  try {
    const url = new URL(request.url);
    const fileUrl = url.searchParams.get("url");

    if (!fileUrl) {
      return NextResponse.json(null, { status: 400 });
    }

    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    if (restApiEndpoint) {
      try {
        // Get auth headers (automatically uses Clerk's auth() and currentUser())
        const headers = await createBackendAuthHeaders();

        const apiUrl = `${restApiEndpoint}/v1/explore/get-line-context-content?url=${encodeURIComponent(fileUrl)}`;
        const apiResponse = await fetch(apiUrl, {
          method: "GET",
          headers,
        });

        if (!apiResponse.ok) {
          throw new Error(
            `REST API call failed with status: ${apiResponse.status}`,
          );
        }

        const apiData: CodeResponse = await apiResponse.json();

        return NextResponse.json(apiData);
      } catch (apiError) {
        console.error("REST API call failed:", apiError);
        // Fall back to empty code response if REST API fails
        console.log("Falling back to empty code response due to API error");
      }
    }

    // Fallback to empty code response when REST_API_ENDPOINT is not set or API call fails
    const emptyCodeResponse: CodeResponse = {
      line: "",
      lines_above: [],
      lines_below: [],
      error_message: null,
    };

    return NextResponse.json(emptyCodeResponse);
  } catch (error) {
    console.error("Get File Line Context Content API Error:", error);

    const emptyCodeResponse: CodeResponse = {
      line: "",
      lines_above: null,
      lines_below: null,
      error_message: null,
    };

    return NextResponse.json(emptyCodeResponse, { status: 500 });
  }
}
