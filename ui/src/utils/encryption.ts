/**
 * Utility functions for encrypting and decrypting sensitive data
 * Uses AES-256-CBC which is compatible with Python's cryptography library
 *
 * Python equivalent:
 * from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
 * from cryptography.hazmat.backends import default_backend
 * import hashlib
 * import base64
 *
 * def get_key(secret: str) -> bytes:
 *     return hashlib.sha256(secret.encode()).digest()
 *
 * def encrypt(value: str, secret: str) -> str:
 *     key = get_key(secret)
 *     iv = os.urandom(16)
 *     cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
 *     encryptor = cipher.encryptor()
 *     # Pad to AES block size
 *     pad_len = 16 - (len(value) % 16)
 *     padded = value + chr(pad_len) * pad_len
 *     encrypted = encryptor.update(padded.encode()) + encryptor.finalize()
 *     return base64.b64encode(iv + encrypted).decode()
 *
 * def decrypt(encrypted_value: str, secret: str) -> str:
 *     key = get_key(secret)
 *     data = base64.b64decode(encrypted_value)
 *     iv = data[:16]
 *     encrypted = data[16:]
 *     cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
 *     decryptor = cipher.decryptor()
 *     decrypted = decryptor.update(encrypted) + decryptor.finalize()
 *     pad_len = decrypted[-1]
 *     return decrypted[:-pad_len].decode()
 */

/**
 * Get encryption key from environment or use default for local mode
 */
const getEncryptionSecret = (): string => {
  // Always use "LOCAL" for now since client-side encryption key
  // cannot be truly secret in browser environment
  // TODO: Move encryption to server-side for better security
  return "LOCAL";
};

/**
 * Convert string to SHA256 hash (32 bytes for AES-256)
 */
async function sha256(message: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * PKCS7 padding
 */
function addPadding(data: Uint8Array): Uint8Array {
  const blockSize = 16;
  const padLength = blockSize - (data.length % blockSize);
  const padded = new Uint8Array(data.length + padLength);
  padded.set(data);
  for (let i = data.length; i < padded.length; i++) {
    padded[i] = padLength;
  }
  return padded;
}

/**
 * Remove PKCS7 padding
 */
function removePadding(data: Uint8Array): Uint8Array {
  const padLength = data[data.length - 1];
  return data.slice(0, data.length - padLength);
}

/**
 * Encrypt a value using AES-256-CBC
 */
export async function encryptValue(value: string): Promise<string> {
  if (!value) return "";

  try {
    const secret = getEncryptionSecret();
    const keyBytes = await sha256(secret);

    // Import key (use the buffer from Uint8Array)
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );

    // Generate random IV (16 bytes for AES)
    const iv = crypto.getRandomValues(new Uint8Array(16));

    // Encode the data (no manual padding needed - Web Crypto API handles it)
    const encoder = new TextEncoder();
    const data = encoder.encode(value);

    // Encrypt (Web Crypto API automatically applies PKCS7 padding)
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: iv.buffer as ArrayBuffer },
      key,
      data.buffer as ArrayBuffer,
    );

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    // Convert to base64
    return btoa(String.fromCharCode(...Array.from(combined)));
  } catch (e) {
    console.error("Error encrypting data:", e);
    return "";
  }
}

/**
 * Decrypt a value using AES-256-CBC
 */
export async function decryptValue(encryptedValue: string): Promise<string> {
  if (!encryptedValue) return "";

  try {
    const secret = getEncryptionSecret();
    const keyBytes = await sha256(secret);

    // Import key (use the buffer from Uint8Array)
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes.buffer as ArrayBuffer,
      { name: "AES-CBC" },
      false,
      ["decrypt"],
    );

    // Decode from base64
    const combined = Uint8Array.from(atob(encryptedValue), (c) =>
      c.charCodeAt(0),
    );

    // Extract IV and encrypted data
    const iv = combined.slice(0, 16);
    const data = combined.slice(16);

    // Decrypt (Web Crypto API automatically removes PKCS7 padding)
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv.buffer as ArrayBuffer },
      key,
      data.buffer as ArrayBuffer,
    );

    // Decode to string (no manual unpadding needed)
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (e) {
    console.error("Error decrypting data:", e);
    return "";
  }
}

/**
 * Encrypt an object's sensitive fields
 */
export async function encryptSensitiveFields(
  obj: any,
  sensitiveFields: string[],
): Promise<any> {
  if (!obj) return obj;

  const encrypted = { ...obj };
  for (const field of sensitiveFields) {
    if (encrypted[field]) {
      encrypted[field] = await encryptValue(encrypted[field]);
    }
  }
  return encrypted;
}

/**
 * Decrypt an object's sensitive fields
 */
export async function decryptSensitiveFields(
  obj: any,
  sensitiveFields: string[],
): Promise<any> {
  if (!obj) return obj;

  const decrypted = { ...obj };
  for (const field of sensitiveFields) {
    if (decrypted[field]) {
      decrypted[field] = await decryptValue(decrypted[field]);
    }
  }
  return decrypted;
}
