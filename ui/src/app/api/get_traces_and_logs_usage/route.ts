import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export async function GET(request: NextRequest) {
  try {
    const restApiEndpoint = process.env.REST_API_ENDPOINT;

    let authorization = request.headers.get("authorization");

    // Try Clerk authentication if no Bearer token provided
    if (!authorization) {
      try {
        const { userId, getToken } = await auth();
        if (userId) {
          const token = await getToken();
          if (token) {
            authorization = `Bearer ${token}`;
          }
        }
      } catch (clerkError) {
        console.log("Clerk auth not available");
      }
    }

    if (!authorization) {
      return NextResponse.json(
        { error: "Authorization required" },
        { status: 401 },
      );
    }

    // Get since_date from query parameters
    const { searchParams } = new URL(request.url);
    const sinceDate = searchParams.get("since_date");

    if (!sinceDate) {
      return NextResponse.json(
        { error: "since_date parameter required" },
        { status: 400 },
      );
    }

    // Forward request to backend with query parameters
    const backendUrl = new URL(
      `${restApiEndpoint}/v1/explore/get-traces-and-logs-since-date`,
    );
    backendUrl.searchParams.set("since_date", sinceDate);

    const response = await fetch(backendUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: authorization,
      },
    });

    if (!response.ok) {
      throw new Error(`Backend responded with ${response.status}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error fetching traces and logs usage:", error);
    return NextResponse.json(
      { error: "Failed to fetch traces and logs usage" },
      { status: 500 },
    );
  }
}
