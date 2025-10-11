import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { connectToDatabase, isMongoDBAvailable } from "@/lib/mongodb";
import {
  TraceProviderConfig,
  LogProviderConfig,
  ITraceProviderConfig,
  ILogProviderConfig,
} from "@/models/provider";

function mergeProviderConfigs(
  traceConfig: ITraceProviderConfig | null,
  logConfig: ILogProviderConfig | null,
) {
  if (!traceConfig && !logConfig) {
    return null;
  }

  const latestTimestamp = (() => {
    const timestamps = [traceConfig?.updatedAt, logConfig?.updatedAt].filter(
      Boolean,
    ) as Date[];
    if (timestamps.length === 0) {
      return undefined;
    }
    return timestamps.reduce((latest, current) =>
      current > latest ? current : latest,
    );
  })();

  return {
    traceProvider: traceConfig?.traceProvider,
    awsTraceConfig: traceConfig?.awsTraceConfig,
    tencentTraceConfig: traceConfig?.tencentTraceConfig,
    jaegerTraceConfig: traceConfig?.jaegerTraceConfig,
    logProvider: logConfig?.logProvider,
    awsLogConfig: logConfig?.awsLogConfig,
    tencentLogConfig: logConfig?.tencentLogConfig,
    jaegerLogConfig: logConfig?.jaegerLogConfig,
    updatedAt: latestTimestamp,
  };
}

// GET - Retrieve provider configuration for a user
export async function GET(request: NextRequest) {
  console.log("🔍 [Provider Config GET] Request received");
  try {
    // Verify user is authenticated via Clerk
    console.log("🔐 [Provider Config GET] Attempting Clerk auth...");
    const { userId } = await auth();
    console.log("✅ [Provider Config GET] Auth result - userId:", userId);

    if (!userId) {
      console.log("❌ [Provider Config GET] No userId - returning 401");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user details from Clerk
    console.log("👤 [Provider Config GET] Fetching current user...");
    const user = await currentUser();
    if (!user) {
      console.log("❌ [Provider Config GET] User not found");
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const userEmail = user.emailAddresses[0]?.emailAddress;
    console.log("📧 [Provider Config GET] userEmail from Clerk:", userEmail);

    if (!userEmail) {
      console.log("❌ [Provider Config GET] User email not found");
      return NextResponse.json(
        { error: "User email not found" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const providerType = searchParams.get("providerType");
    console.log("🔧 [Provider Config GET] providerType:", providerType);

    if (providerType && providerType !== "trace" && providerType !== "log") {
      return NextResponse.json(
        { error: "providerType must be either 'trace' or 'log'" },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    console.log("💾 [Provider Config GET] Checking MongoDB availability...");
    if (!isMongoDBAvailable()) {
      console.log("❌ [Provider Config GET] MongoDB not available");
      return NextResponse.json(
        {
          error: "Database not configured",
          message:
            "MongoDB is not available. Please configure MONGODB_URI environment variable.",
          mongoAvailable: false,
        },
        { status: 503 },
      );
    }

    console.log("🔌 [Provider Config GET] Connecting to database...");
    await connectToDatabase();

    console.log("🔎 [Provider Config GET] Fetching configs from DB...");
    const [traceConfig, logConfig] = await Promise.all([
      TraceProviderConfig.findOne({ userEmail }),
      LogProviderConfig.findOne({ userEmail }),
    ]);

    console.log(
      "📊 [Provider Config GET] Configs found - trace:",
      !!traceConfig,
      "log:",
      !!logConfig,
    );
    const mergedConfig = mergeProviderConfigs(traceConfig, logConfig);

    if (!mergedConfig) {
      console.log("ℹ️ [Provider Config GET] No config found - returning null");
      return NextResponse.json(
        {
          userEmail,
          mongoAvailable: true,
          config: null,
        },
        { status: 200 },
      );
    }

    console.log("✅ [Provider Config GET] Returning merged config");
    return NextResponse.json({
      userEmail,
      mongoAvailable: true,
      config: mergedConfig,
    });
  } catch (error) {
    console.error(
      "💥 [Provider Config GET] Error fetching provider config:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch provider configuration" },
      { status: 500 },
    );
  }
}

// POST - Create or update provider configuration
export async function POST(request: NextRequest) {
  console.log("📝 [Provider Config POST] Request received");
  try {
    // Verify user is authenticated via Clerk
    console.log("🔐 [Provider Config POST] Attempting Clerk auth...");
    const { userId } = await auth();
    console.log("✅ [Provider Config POST] Auth result - userId:", userId);

    if (!userId) {
      console.log("❌ [Provider Config POST] No userId - returning 401");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user details from Clerk
    console.log("👤 [Provider Config POST] Fetching current user...");
    const user = await currentUser();
    if (!user) {
      console.log("❌ [Provider Config POST] User not found");
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const userEmail = user.emailAddresses[0]?.emailAddress;
    console.log("📧 [Provider Config POST] userEmail from Clerk:", userEmail);

    if (!userEmail) {
      console.log("❌ [Provider Config POST] User email not found");
      return NextResponse.json(
        { error: "User email not found" },
        { status: 401 },
      );
    }

    const body = await request.json();
    const configData = body;
    console.log(
      "📦 [Provider Config POST] configData keys:",
      Object.keys(configData),
    );

    // Check if MongoDB is available
    console.log("💾 [Provider Config POST] Checking MongoDB availability...");
    if (!isMongoDBAvailable()) {
      console.log("❌ [Provider Config POST] MongoDB not available");
      return NextResponse.json(
        {
          error: "Database not configured",
          message:
            "MongoDB is not available. Tencent Cloud configuration is disabled.",
          mongoAvailable: false,
        },
        { status: 503 },
      );
    }

    console.log("🔌 [Provider Config POST] Connecting to database...");
    await connectToDatabase();

    // Update or create provider configuration
    console.log("🔧 [Provider Config POST] Preparing updates...");
    const traceUpdate: Partial<ITraceProviderConfig> = {};
    const logUpdate: Partial<ILogProviderConfig> = {};

    if ("traceProvider" in configData) {
      traceUpdate.traceProvider = configData.traceProvider;
    }
    if ("awsTraceConfig" in configData) {
      traceUpdate.awsTraceConfig = configData.awsTraceConfig;
    }
    if ("tencentTraceConfig" in configData) {
      traceUpdate.tencentTraceConfig = configData.tencentTraceConfig;
    }
    if ("jaegerTraceConfig" in configData) {
      traceUpdate.jaegerTraceConfig = configData.jaegerTraceConfig;
    }

    if ("logProvider" in configData) {
      logUpdate.logProvider = configData.logProvider;
    }
    if ("awsLogConfig" in configData) {
      logUpdate.awsLogConfig = configData.awsLogConfig;
    }
    if ("tencentLogConfig" in configData) {
      logUpdate.tencentLogConfig = configData.tencentLogConfig;
    }
    if ("jaegerLogConfig" in configData) {
      logUpdate.jaegerLogConfig = configData.jaegerLogConfig;
    }

    console.log(
      "💾 [Provider Config POST] Saving to DB - trace keys:",
      Object.keys(traceUpdate).length,
      "log keys:",
      Object.keys(logUpdate).length,
    );
    await Promise.all([
      Object.keys(traceUpdate).length > 0
        ? TraceProviderConfig.findOneAndUpdate(
            { userEmail },
            {
              $set: traceUpdate,
              $setOnInsert: { userEmail },
            },
            { upsert: true, new: false, runValidators: true },
          )
        : null,
      Object.keys(logUpdate).length > 0
        ? LogProviderConfig.findOneAndUpdate(
            { userEmail },
            {
              $set: logUpdate,
              $setOnInsert: { userEmail },
            },
            { upsert: true, new: false, runValidators: true },
          )
        : null,
    ]);

    console.log("🔎 [Provider Config POST] Fetching updated configs...");
    const [traceConfig, logConfig] = await Promise.all([
      TraceProviderConfig.findOne({ userEmail }),
      LogProviderConfig.findOne({ userEmail }),
    ]);

    console.log(
      "✅ [Provider Config POST] Successfully saved and returning config",
    );
    return NextResponse.json({
      success: true,
      message: "Provider configuration saved successfully",
      config: mergeProviderConfigs(traceConfig, logConfig),
    });
  } catch (error) {
    console.error(
      "💥 [Provider Config POST] Error saving provider config:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to save provider configuration" },
      { status: 500 },
    );
  }
}

// DELETE - Delete provider configuration for a user
export async function DELETE(request: NextRequest) {
  console.log("🗑️ [Provider Config DELETE] Request received");
  try {
    // Verify user is authenticated via Clerk
    console.log("🔐 [Provider Config DELETE] Attempting Clerk auth...");
    const { userId } = await auth();
    console.log("✅ [Provider Config DELETE] Auth result - userId:", userId);

    if (!userId) {
      console.log("❌ [Provider Config DELETE] No userId - returning 401");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get user details from Clerk
    console.log("👤 [Provider Config DELETE] Fetching current user...");
    const user = await currentUser();
    if (!user) {
      console.log("❌ [Provider Config DELETE] User not found");
      return NextResponse.json({ error: "User not found" }, { status: 401 });
    }

    const userEmail = user.emailAddresses[0]?.emailAddress;
    console.log("📧 [Provider Config DELETE] userEmail from Clerk:", userEmail);

    if (!userEmail) {
      console.log("❌ [Provider Config DELETE] User email not found");
      return NextResponse.json(
        { error: "User email not found" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const providerTypeParam = searchParams.get("providerType");
    const provider = searchParams.get("provider"); // aws, tencent, or jaeger
    console.log("🔧 [Provider Config DELETE] providerType:", providerTypeParam);
    console.log("🔧 [Provider Config DELETE] provider:", provider);

    if (
      providerTypeParam &&
      providerTypeParam !== "trace" &&
      providerTypeParam !== "log"
    ) {
      return NextResponse.json(
        { error: "providerType must be either 'trace' or 'log'" },
        { status: 400 },
      );
    }

    if (
      provider &&
      provider !== "aws" &&
      provider !== "tencent" &&
      provider !== "jaeger"
    ) {
      return NextResponse.json(
        { error: "provider must be either 'aws', 'tencent', or 'jaeger'" },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    console.log("💾 [Provider Config DELETE] Checking MongoDB availability...");
    if (!isMongoDBAvailable()) {
      console.log("❌ [Provider Config DELETE] MongoDB not available");
      return NextResponse.json(
        {
          error: "Database not configured",
          message: "MongoDB is not available.",
          mongoAvailable: false,
        },
        { status: 503 },
      );
    }

    console.log("🔌 [Provider Config DELETE] Connecting to database...");
    await connectToDatabase();

    let deleted = false;
    const providerType = providerTypeParam as "trace" | "log" | null;

    console.log("🗑️ [Provider Config DELETE] Deleting configs...");

    // If specific provider is specified, only unset that provider's config
    if (provider) {
      if (!providerType || providerType === "trace") {
        const unsetField = `${provider}TraceConfig`;
        const traceResult = await TraceProviderConfig.findOneAndUpdate(
          { userEmail },
          { $unset: { [unsetField]: "" } },
          { new: true },
        );
        deleted = deleted || !!traceResult;
        console.log(
          `📊 [Provider Config DELETE] Trace ${provider} config unset:`,
          !!traceResult,
        );
      }

      if (!providerType || providerType === "log") {
        const unsetField = `${provider}LogConfig`;
        const logResult = await LogProviderConfig.findOneAndUpdate(
          { userEmail },
          { $unset: { [unsetField]: "" } },
          { new: true },
        );
        deleted = deleted || !!logResult;
        console.log(
          `📊 [Provider Config DELETE] Log ${provider} config unset:`,
          !!logResult,
        );
      }
    } else {
      // If no provider specified, delete entire document(s)
      if (!providerType || providerType === "trace") {
        const traceResult = await TraceProviderConfig.findOneAndDelete({
          userEmail,
        });
        deleted = deleted || !!traceResult;
        console.log(
          "📊 [Provider Config DELETE] Trace config deleted:",
          !!traceResult,
        );
      }

      if (!providerType || providerType === "log") {
        const logResult = await LogProviderConfig.findOneAndDelete({
          userEmail,
        });
        deleted = deleted || !!logResult;
        console.log(
          "📊 [Provider Config DELETE] Log config deleted:",
          !!logResult,
        );
      }
    }

    if (!deleted) {
      console.log("⚠️ [Provider Config DELETE] No config found to delete");
      return NextResponse.json(
        { error: "Configuration not found" },
        { status: 404 },
      );
    }

    console.log("✅ [Provider Config DELETE] Successfully deleted config");
    return NextResponse.json({
      success: true,
      message: "Provider configuration deleted successfully",
    });
  } catch (error) {
    console.error(
      "💥 [Provider Config DELETE] Error deleting provider config:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to delete provider configuration" },
      { status: 500 },
    );
  }
}
