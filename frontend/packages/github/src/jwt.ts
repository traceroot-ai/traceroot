import jwt from "jsonwebtoken";

export function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now, exp: now + 600, iss: appId }, privateKey, { algorithm: "RS256" });
}
