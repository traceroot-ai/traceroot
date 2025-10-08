import { autumnHandler } from "autumn-js/next";
import { auth } from "@clerk/nextjs/server";

export const { GET, POST } = autumnHandler({
  identify: async (request) => {
    console.log("🚀 ===== AUTUMN IDENTIFY FUNCTION START =====");
    console.log("📅 Timestamp:", new Date().toISOString());
    console.log("🌐 Request method:", request?.method);
    console.log("🔗 Request URL:", request?.url);
    console.log(
      "📋 Request headers:",
      Object.fromEntries(request?.headers.entries() || []),
    );

    if (process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true") {
      console.log(
        "🔧 PAYMENT DISABLED: Autumn is set to be disabled via environment variable",
      );
      console.log("👤 Returning local user for development");
      const localUser = {
        customerId: "local-user",
        customerData: {
          email: "local@example.com",
        },
      };
      console.log("✅ Local user data:", localUser);
      console.log("🏁 ===== AUTUMN IDENTIFY FUNCTION END (LOCAL USER) =====");
      return localUser;
    }

    console.log("🔍 Autumn identify function called for production");
    console.log(
      "🔧 Environment check: NEXT_PUBLIC_DISABLE_PAYMENT =",
      process.env.NEXT_PUBLIC_DISABLE_PAYMENT,
    );
    try {
      console.log("🔐 Starting Clerk authentication process...");

      // Clerk authentication
      console.log("🔍 Attempting Clerk authentication...");
      const { userId } = await auth();
      console.log("🔑 Clerk auth result - userId:", userId);

      if (!userId) {
        console.log(
          "⏭️ No userId - likely during login transition, skipping identify",
        );
        console.log("🏁 ===== AUTUMN IDENTIFY FUNCTION END (NO USER) =====");
        // Return a dummy customer to prevent Autumn errors during login transition
        return {
          customerId: "pending",
          customerData: {},
        };
      }

      if (userId) {
        console.log("✅ User authenticated with Clerk successfully!");
        console.log("👤 Clerk userId:", userId);

        // Get user data from Clerk
        console.log("📞 Importing Clerk client...");
        const { clerkClient } = await import("@clerk/nextjs/server");
        console.log("🔧 Creating Clerk client instance...");
        const client = await clerkClient();
        console.log("👥 Fetching user data from Clerk...");
        const user = await client.users.getUser(userId);

        console.log("📊 Clerk user data received:", {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          emailAddresses: user.emailAddresses?.map((addr) => addr.emailAddress),
          hasEmailAddresses: !!user.emailAddresses?.length,
        });

        const clerkResult = {
          customerId: userId,
          customerData: {
            name:
              `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
              undefined,
            email: user.emailAddresses[0]?.emailAddress || undefined,
          },
        };

        console.log("✅ Returning Clerk user data:", clerkResult);
        console.log("🏁 ===== AUTUMN IDENTIFY FUNCTION END (CLERK USER) =====");
        return clerkResult;
      }

      console.log("⚠️ No Clerk user found");
      console.log("🏁 ===== AUTUMN IDENTIFY FUNCTION END (NO USER) =====");
      return null;
    } catch (error) {
      console.error("💥 ===== ERROR IN AUTUMN IDENTIFY =====");
      console.error("❌ Error occurred during authentication process");
      console.error("🔍 Error type:", typeof error);
      console.error(
        "📝 Error message:",
        error instanceof Error ? error.message : String(error),
      );
      console.error(
        "📚 Error stack:",
        error instanceof Error ? error.stack : "No stack trace available",
      );
      console.error("🔍 Full error object:", error);
      console.error("🏁 ===== AUTUMN IDENTIFY FUNCTION END (ERROR) =====");
      return null;
    }
  },
});
