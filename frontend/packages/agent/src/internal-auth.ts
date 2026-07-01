export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

export function getInternalApiSecret(): string {
  return process.env.INTERNAL_API_SECRET ?? "";
}

export function hasValidInternalSecret(request: Request): boolean {
  const expectedSecret = getInternalApiSecret();
  return Boolean(expectedSecret) && request.headers.get(INTERNAL_SECRET_HEADER) === expectedSecret;
}
