import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { randomBytes, createHash } from "crypto";
import { TokenResource, ResourceType } from "@/models/integrate";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import { ConnectionToken, TracerootToken } from "@/models/token";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

interface IntegrationSecretResponse {
  success: boolean;
  token?: string;
  error?: string;
}

/**
 * Hash user_sub to create consistent identifier (matches Python implementation)
 */
function hashUserSub(userSub: string): string {
  return createHash("sha256").update(userSub, "utf-8").digest("hex");
}

/**
 * Generate a random TraceRoot token (matches Python implementation)
 */
function generateTracerootToken(): string {
  const tokenUuid = randomBytes(16).toString("hex");
  return `traceroot-${tokenUuid}`;
}

/**
 * Generate user credentials with AWS STS assume role (matches Python implementation)
 */
async function generateUserCredentials(
  userSub: string,
  userEmail: string,
): Promise<{
  user_email: string;
  user_sub: string;
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token: string;
  region: string;
  hash: string;
  expiration_utc: Date;
  otlp_endpoint: string | undefined;
  provider_type: string;
}> {
  const hashedUserSub = hashUserSub(userSub);

  // Clean up hashed user_sub for use in RoleSessionName
  // AWS role session names must be 2-64 characters and can only contain
  // alphanumeric characters, underscores, or these chars: =,.@-
  const cleanUserSub = hashedUserSub.replace(/[^a-zA-Z0-9_=,.@-]/g, "");
  let sessionName = `session-${cleanUserSub}`;

  // Truncate if too long (max 64 characters)
  if (sessionName.length > 64) {
    sessionName = sessionName.substring(0, 64);
  }

  try {
    const stsClient = new STSClient({ region: "us-west-2" });

    const command = new AssumeRoleCommand({
      RoleArn: "arn:aws:iam::965747688757:role/UserLogRole",
      RoleSessionName: sessionName,
      Tags: [
        {
          Key: "user-sub",
          Value: hashedUserSub,
        },
      ],
      DurationSeconds: 43200, // 12 hours
    });

    const response = await stsClient.send(command);

    if (!response.Credentials) {
      throw new Error("Failed to get credentials from STS");
    }

    const creds = response.Credentials;

    return {
      user_email: userEmail,
      user_sub: userSub, // SDK will use this for span attributes
      aws_access_key_id: creds.AccessKeyId!,
      aws_secret_access_key: creds.SecretAccessKey!,
      aws_session_token: creds.SessionToken!,
      region: "us-west-2",
      hash: hashedUserSub, // Keep for AWS log group naming only
      expiration_utc: creds.Expiration!,
      otlp_endpoint: process.env.OTLP_ENDPOINT,
      provider_type: "aws",
    };
  } catch (e) {
    throw new Error(
      `Failed to generate user credentials: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * POST /api/post_connect
 * Inserts integration tokens directly into MongoDB
 */
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
      resourceType: tokenResource.resourceType,
      hasToken: !!tokenResource.token,
      tokenLength: tokenResource.token?.length || 0,
    });

    // Validate request
    if (
      !tokenResource.token &&
      tokenResource.resourceType !== ResourceType.TRACEROOT
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Token is required for non-TraceRoot resources",
        },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    const isLocalMode = process.env.NEXT_PUBLIC_LOCAL_MODE === "true";
    if (!isMongoDBAvailable() && !isLocalMode) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
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

    let token = tokenResource.token;

    // Handle TraceRoot resource type
    if (tokenResource.resourceType === ResourceType.TRACEROOT) {
      if (isLocalMode) {
        // Return fake token for local mode
        console.log(
          `[${requestId}] Local mode - returning fake TraceRoot token`,
        );
        return NextResponse.json({
          success: true,
          token: "fake_traceroot_token_for_local_mode",
        });
      }

      // Generate TraceRoot token and AWS credentials
      token = generateTracerootToken();
      console.log(`[${requestId}] Generated TraceRoot token`);

      try {
        const userCredentials = await generateUserCredentials(
          userId,
          userEmail,
        );

        // Connect to MongoDB and insert TraceRoot token
        await connectToDatabase();

        // Delete existing tokens for this user (if any)
        await TracerootToken.deleteMany({
          user_email: userEmail,
        });

        // Insert new token with credentials (flat structure matching Python)
        await TracerootToken.create({
          token,
          user_email: userCredentials.user_email,
          user_sub: userCredentials.user_sub,
          aws_access_key_id: userCredentials.aws_access_key_id,
          aws_secret_access_key: userCredentials.aws_secret_access_key,
          aws_session_token: userCredentials.aws_session_token,
          region: userCredentials.region,
          hash: userCredentials.hash,
          expiration_utc: userCredentials.expiration_utc,
          otlp_endpoint:
            userCredentials.otlp_endpoint || "http://3.13.23.97:4318/v1/traces",
          provider_type: userCredentials.provider_type,
        });
      } catch (credError) {
        console.error(
          `[${requestId}] Error generating credentials:`,
          credError,
        );
        return NextResponse.json(
          {
            success: false,
            error:
              credError instanceof Error
                ? credError.message
                : "Failed to generate TraceRoot credentials",
          },
          { status: 500 },
        );
      }
    } else {
      // Handle regular integration tokens
      await connectToDatabase();

      // Upsert the integration token
      await ConnectionToken.updateOne(
        {
          user_email: userEmail,
          token_type: tokenResource.resourceType,
        },
        {
          $set: {
            user_email: userEmail,
            token: token!,
            token_type: tokenResource.resourceType,
          },
        },
        { upsert: true },
      );
    }
    return NextResponse.json({
      success: true,
      token: token || undefined,
    });
  } catch (error: unknown) {
    console.error(
      `[${requestId}] Error processing integration secret request:`,
      error,
    );
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
