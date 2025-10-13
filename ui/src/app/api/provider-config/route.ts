import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
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
  try {
    // Verify user is authenticated via Clerk
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const userEmail = searchParams.get("userEmail");
    const providerType = searchParams.get("providerType");

    if (providerType && providerType !== "trace" && providerType !== "log") {
      return NextResponse.json(
        { error: "providerType must be either 'trace' or 'log'" },
        { status: 400 },
      );
    }

    if (!userEmail) {
      return NextResponse.json(
        { error: "userEmail is required" },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
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

    await connectToDatabase();

    const [traceConfig, logConfig] = await Promise.all([
      TraceProviderConfig.findOne({ userEmail }),
      LogProviderConfig.findOne({ userEmail }),
    ]);

    const mergedConfig = mergeProviderConfigs(traceConfig, logConfig);

    if (!mergedConfig) {
      return NextResponse.json(
        {
          userEmail,
          mongoAvailable: true,
          config: null,
        },
        { status: 200 },
      );
    }

    return NextResponse.json({
      userEmail,
      mongoAvailable: true,
      config: mergedConfig,
    });
  } catch (error) {
    console.error("Error fetching provider config:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider configuration" },
      { status: 500 },
    );
  }
}

// POST - Create or update provider configuration
export async function POST(request: NextRequest) {
  try {
    // Verify user is authenticated via Clerk
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { userEmail, ...configData } = body;

    if (!userEmail) {
      return NextResponse.json(
        { error: "userEmail is required" },
        { status: 400 },
      );
    }

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
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

    await connectToDatabase();

    // Update or create provider configuration
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

    const [traceConfig, logConfig] = await Promise.all([
      TraceProviderConfig.findOne({ userEmail }),
      LogProviderConfig.findOne({ userEmail }),
    ]);

    return NextResponse.json({
      success: true,
      message: "Provider configuration saved successfully",
      config: mergeProviderConfigs(traceConfig, logConfig),
    });
  } catch (error) {
    console.error("Error saving provider config:", error);
    return NextResponse.json(
      { error: "Failed to save provider configuration" },
      { status: 500 },
    );
  }
}

// DELETE - Delete provider configuration for a user
export async function DELETE(request: NextRequest) {
  try {
    // Verify user is authenticated via Clerk
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const userEmail = searchParams.get("userEmail");
    const providerTypeParam = searchParams.get("providerType");

    if (!userEmail) {
      return NextResponse.json(
        { error: "userEmail is required" },
        { status: 400 },
      );
    }

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

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return NextResponse.json(
        {
          error: "Database not configured",
          message: "MongoDB is not available.",
          mongoAvailable: false,
        },
        { status: 503 },
      );
    }

    await connectToDatabase();

    let deleted = false;
    const providerType = providerTypeParam as "trace" | "log" | null;

    if (!providerType || providerType === "trace") {
      const traceResult = await TraceProviderConfig.findOneAndDelete({
        userEmail,
      });
      deleted = deleted || !!traceResult;
    }

    if (!providerType || providerType === "log") {
      const logResult = await LogProviderConfig.findOneAndDelete({ userEmail });
      deleted = deleted || !!logResult;
    }

    if (!deleted) {
      return NextResponse.json(
        { error: "Configuration not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Provider configuration deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting provider config:", error);
    return NextResponse.json(
      { error: "Failed to delete provider configuration" },
      { status: 500 },
    );
  }
}
