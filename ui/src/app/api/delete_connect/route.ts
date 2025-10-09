import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { createHash } from "crypto";
import { ResourceType } from "@/models/integrate";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import { ConnectionToken, TracerootToken } from "@/models/token";

interface DeleteIntegrationRequest {
  resource_type: string;
}

interface DeleteIntegrationResponse {
  success: boolean;
  error?: string;
}

/**
 * Hash user_sub to create consistent identifier (matches Python implementation)
 */
function hashUserSub(userSub: string): string {
  return createHash("sha256").update(userSub, "utf-8").digest("hex");
}

/**
 * DELETE /api/delete_connect
 * Deletes integration tokens for a specific resource type directly from MongoDB
 */
export async function DELETE(
  request: Request,
): Promise<NextResponse<DeleteIntegrationResponse>> {
  try {
    // Parse the request body to get resource_type
    const { resource_type }: DeleteIntegrationRequest = await request.json();

    if (!resource_type) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required parameter: resource_type",
        },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return NextResponse.json({
        success: true,
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

    let deleteResult;

    if (resource_type === ResourceType.TRACEROOT) {
      // Delete from traceroot_tokens collection using user_email
      deleteResult = await TracerootToken.deleteMany({
        user_email: userEmail,
      });
    } else {
      // Delete from connection_tokens collection using user_email and token_type
      deleteResult = await ConnectionToken.deleteOne({
        user_email: userEmail,
        token_type: resource_type,
      });
    }

    return NextResponse.json({
      success: deleteResult.deletedCount > 0,
    });
  } catch (error: unknown) {
    console.error("Error processing delete integration request:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to process delete integration request",
      },
      { status: 500 },
    );
  }
}
