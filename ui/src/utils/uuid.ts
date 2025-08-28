/**
 * Generates a Python-like UUID hex string (32-character hexadecimal without dashes)
 * Equivalent to Python's uuid.uuid4().hex
 */
export function generateUuidHex(): string {
  // Generate a standard UUID first
  const uuid = crypto.randomUUID();

  // Remove dashes to get the hex format like Python's uuid.hex
  return uuid.replace(/-/g, "");
}
