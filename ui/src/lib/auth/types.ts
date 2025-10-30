/**
 * Shared authentication types for both CE and EE implementations
 */

export interface AuthUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isLoaded: boolean;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
}

export interface AuthProviderProps {
  children: React.ReactNode;
}

export interface ServerAuthResult {
  userSecret: string;
  userId: string | null;
  userEmail: string | null;
}

export interface ServerAuthHeaders {
  "Content-Type": string;
  "x-clerk-user-id": string;
  "x-clerk-user-email": string;
}
