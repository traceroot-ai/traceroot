/**
 * Constants for self-hosted mode
 * Used when NEXT_PUBLIC_DISABLE_PAYMENT=true
 */

export const LOCAL_USER = {
  USER_ID: "local-user",
  USER_EMAIL: "local@traceroot.local",
  USER_SECRET: "local-secret-token",
} as const;
