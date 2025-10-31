/**
 * Local/mock user constants for development and self-hosted deployments
 * Used when NEXT_PUBLIC_DISABLE_AUTH=true
 */
export const LOCAL_USER_CONSTANTS = {
  USER_ID: "local-user",
  USER_EMAIL: "local@example.com",
  USER_FIRST_NAME: "Local",
  USER_LAST_NAME: "User",
} as const;
