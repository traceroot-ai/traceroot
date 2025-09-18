import { autumnHandler } from "autumn-js/next";
import { cookies } from "next/headers";
import { jwtDecode } from "jwt-decode";

// Define the type for Cognito JWT claims
interface CognitoJwtClaims {
  sub: string;
  email: string;
  given_name?: string;
  family_name?: string;
  [key: string]: any;
}

export const { GET, POST } = autumnHandler({
  identify: async (request) => {
    if (process.env.NEXT_PUBLIC_LOCAL_MODE === 'true') {
      console.log("⚠️ Autumn is disabled in local mode");
      return {
        customerId: "local-user",
        customerData: {
          email: "local@example.com",
        },
      }; // return mock user
    }
    console.log('🔍 Autumn identify function called', {
      requestUrl: request?.url,
    });
    try {
      // Get the cookies - we need both session (access token) and id_token
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get("session");
      const idTokenCookie = cookieStore.get("id_token");

      console.log("📝 Cookie status:", {
        hasSessionCookie: !!sessionCookie?.value,
        hasIdTokenCookie: !!idTokenCookie?.value,
      });

      if (!sessionCookie?.value || !idTokenCookie?.value) {
        console.error("❌ Missing required cookies");
        return null;
      }

      // Use ID token for user identification (contains email and user claims)
      const idToken = idTokenCookie.value;
      console.log("🔑 ID token retrieved successfully");

      // Decode the JWT token to get user information
      const decodedToken = jwtDecode<CognitoJwtClaims>(idToken);
      console.log("👤 Decoded token claims:", {
        sub: decodedToken.sub,
        email: decodedToken.email,
        hasGivenName: !!decodedToken["given_name"],
        hasFamilyName: !!decodedToken["family_name"],
      });

      // Extract user information from the token claims
      const customerId = decodedToken.sub; // Cognito User Sub ID
      const email = decodedToken.email;
      const givenName = decodedToken["given_name"];
      const familyName = decodedToken["family_name"];

      const result = {
        customerId,
        customerData: {
          name: `${givenName || ""} ${familyName || ""}`.trim() || undefined,
          email: email || undefined,
        },
      };
      console.log("✅ Returning user data:", result);
      return result;
    } catch (error) {
      console.error("Error in Autumn identify:", error);
      return null;
    }
  },
});
