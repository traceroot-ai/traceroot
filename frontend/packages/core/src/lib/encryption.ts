import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
/** Initialization vector length in bytes. A random IV ensures identical plaintexts produce different ciphertexts. */
const INIT_VECTOR_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be set to a 64-character hex string (256 bits).");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns `base64(iv):base64(ciphertext):base64(authTag)`.
 */
export function encryptKey(plaintext: string): string {
  const key = getEncryptionKey();
  const initVector = randomBytes(INIT_VECTOR_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, initVector, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${initVector.toString("base64")}:${encrypted.toString("base64")}:${authTag.toString("base64")}`;
}

/**
 * Decrypt a string produced by `encryptKey()`.
 */
export function decryptKey(encrypted: string): string {
  const key = getEncryptionKey();
  const [initVectorB64, ciphertextB64, tagB64] = encrypted.split(":");
  if (!initVectorB64 || !ciphertextB64 || !tagB64) {
    throw new Error("Invalid encrypted key format");
  }
  const initVector = Buffer.from(initVectorB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, initVector, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Mask an API key for display: returns `"xxxx...xxxx"` (first 4 + last 4 chars).
 * Follows the same pattern as traceroot API tokens.
 */
export function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + "..." + key.slice(-4);
}
