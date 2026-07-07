export function isGoogleAuthConfigured(clientId: string, clientSecret: string): boolean {
  return Boolean(clientId.trim() && clientSecret.trim());
}
