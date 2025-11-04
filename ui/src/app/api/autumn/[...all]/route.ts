import { autumnHandler } from "autumn-js/next";
import { auth } from "@clerk/nextjs/server";

export const { GET, POST } = autumnHandler({
  identify: async (request) => {
    if (process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true") {
      return {
        customerId: "local-user",
        customerData: {
          email: "local@example.com",
        },
      };
    }

    try {
      // Clerk authentication
      const { userId } = await auth();

      if (!userId) {
        // Return a dummy customer to prevent Autumn errors during login transition
        return {
          customerId: "pending",
          customerData: {},
        };
      }

      if (userId) {
        // Get user data from Clerk
        const { clerkClient } = await import("@clerk/nextjs/server");
        const client = await clerkClient();
        const user = await client.users.getUser(userId);

        return {
          customerId: userId,
          customerData: {
            name:
              `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
              undefined,
            email: user.emailAddresses[0]?.emailAddress || undefined,
          },
        };
      }

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
