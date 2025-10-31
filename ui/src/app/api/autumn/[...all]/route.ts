import { NextResponse } from "next/server";
import { LOCAL_USER_CONSTANTS } from "@/lib/constants/auth";

const DISABLE_PAYMENT = process.env.NEXT_PUBLIC_DISABLE_PAYMENT === "true";

// Export handlers that check at runtime
export async function GET() {
  // When payments are disabled, return mock data
  if (DISABLE_PAYMENT) {
    return NextResponse.json({
      customerId: LOCAL_USER_CONSTANTS.USER_ID,
      customerData: {
        email: LOCAL_USER_CONSTANTS.USER_EMAIL,
      },
    });
  }

  // Otherwise delegate to real Autumn handler
  const { autumnHandler } = await import("autumn-js/next");
  const { auth } = await import("@clerk/nextjs/server");

  const handlers = autumnHandler({
    identify: async () => {
      const { userId } = await auth();
      if (!userId) {
        return {
          customerId: "pending",
          customerData: {},
        };
      }

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
    },
  });

  // @ts-ignore - Dynamic handler delegation
  return handlers.GET(...arguments);
}

export async function POST() {
  // When payments are disabled, return mock data
  if (DISABLE_PAYMENT) {
    return NextResponse.json({
      customerId: LOCAL_USER_CONSTANTS.USER_ID,
      customerData: {
        email: LOCAL_USER_CONSTANTS.USER_EMAIL,
      },
    });
  }

  // Otherwise delegate to real Autumn handler
  const { autumnHandler } = await import("autumn-js/next");
  const { auth } = await import("@clerk/nextjs/server");

  const handlers = autumnHandler({
    identify: async () => {
      try {
        const { userId } = await auth();
        if (!userId) {
          return {
            customerId: "pending",
            customerData: {},
          };
        }

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
      } catch (error) {
        console.error("Error in Autumn identify:", error);
        return null;
      }
    },
  });

  // @ts-ignore - Dynamic handler delegation
  return handlers.POST(...arguments);
}
