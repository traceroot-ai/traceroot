import { autumnHandler } from "autumn-js/next";
import { cookies } from 'next/headers';
import { jwtDecode } from 'jwt-decode';

// Define the type for Cognito JWT claims
interface CognitoJwtClaims {
  sub: string;
  email: string;
  'given_name'?: string;
  'family_name'?: string;
  [key: string]: any;
}

export const { GET, POST } = autumnHandler({
  identify: async (request) => {
    try {
      // Get the cookies - we need both session (access token) and id_token
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get('session');
      const idTokenCookie = cookieStore.get('id_token');

      if (!sessionCookie?.value || !idTokenCookie?.value) {
        throw new Error('No session or ID token cookie found');
      }

      // Use ID token for user identification (contains email and user claims)
      const idToken = idTokenCookie.value;

      // Decode the JWT token to get user information
      const decodedToken = jwtDecode<CognitoJwtClaims>(idToken);

      // Extract user information from the token claims
      const customerId = decodedToken.sub; // Cognito User Sub ID
      const email = decodedToken.email;
      const givenName = decodedToken['given_name'];
      const familyName = decodedToken['family_name'];

      return {
        customerId,
        customerData: {
          name: `${givenName || ''} ${familyName || ''}`.trim() || '',
          email: email || '',
        },
      };
    } catch (error) {
      console.error('Error in Autumn identify:', error);
      return {
        customerId: 'customer_id', // Fallback customer ID
        customerData: {
          name: '',
          email: '',
        },
      };
    }
  },
});
