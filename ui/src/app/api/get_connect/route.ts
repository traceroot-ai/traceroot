import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { createHash } from "crypto";
import { ResourceType } from "@/models/integrate";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import { ConnectionToken, TracerootToken } from "@/models/token";

interface GetIntegrationResponse {
  success: boolean;
  token?: string | null;
  error?: string;
}

/**
 * Hash user_sub to create consistent identifier (matches Python implementation)
 */
function hashUserSub(userSub: string): string {
  return createHash("sha256").update(userSub, "utf-8").digest("hex");
}

/**
 * GET /api/get_connect
 * Fetches integration tokens for a specific resource type directly from MongoDB
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

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return NextResponse.json({
        success: true,
        token: null,
      });
    }

    // Get authenticated user
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "User not authenticated" },
        { status: 401 },
      );
    }

    const user = await currentUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 401 },
      );
    }

    const userEmail = user.emailAddresses[0]?.emailAddress;
    if (!userEmail) {
      return NextResponse.json(
        { success: false, error: "User email not found" },
        { status: 401 },
      );
    }

    // Connect to MongoDB
    await connectToDatabase();

    let token: string | null = null;

    if (resourceType === ResourceType.TRACEROOT) {
      // Query traceroot_tokens collection using user_email
      const tracerootToken = await TracerootToken.findOne({
        user_email: userEmail,
      }).lean();
      token = tracerootToken?.token || null;
    } else {
      // Query connection_tokens collection using user_email and token_type
      const connectionToken = await ConnectionToken.findOne({
        user_email: userEmail,
        token_type: resourceType,
      }).lean();
      token = connectionToken?.token || null;
    }

    return NextResponse.json({
      success: true,
      token,
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
