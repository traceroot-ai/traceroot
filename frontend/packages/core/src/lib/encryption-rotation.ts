import { decryptWithKey, encryptWithKey } from "./encryption.ts";

const isValidKeyHex = (hex: string) => /^[0-9a-fA-F]{64}$/.test(hex);

/** Raised when a stored value cannot be moved to the new key. Never carries key or value text. */
export class EncryptionRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionRotationError";
  }
}

export interface RotatedValue {
  value: string;
  /** False when the value already opened with the new key and was left as is. */
  rotated: boolean;
}

function tryDecrypt(cipher: string, key: Buffer): string | null {
  try {
    return decryptWithKey(cipher, key);
  } catch {
    return null;
  }
}

/**
 * Move one stored value from `oldKeyHex` to `newKeyHex`. A value that already opens
 * with the new key is returned unchanged, so a finished run can be repeated.
 */
export function reencryptValue(cipher: string, oldKeyHex: string, newKeyHex: string): RotatedValue {
  const oldKey = Buffer.from(oldKeyHex, "hex");
  const newKey = Buffer.from(newKeyHex, "hex");
  if (tryDecrypt(cipher, newKey) !== null) return { value: cipher, rotated: false };
  const plaintext = tryDecrypt(cipher, oldKey);
  if (plaintext === null) {
    throw new EncryptionRotationError("value opens with neither the old nor the new key");
  }
  return { value: encryptWithKey(plaintext, newKey), rotated: true };
}

/** The slice of the database client the rotation uses, so it can run against a fake. */
export interface RotationTx {
  modelProvider: {
    findMany(args: {
      select: { id: true; keyCipher: true };
    }): Promise<{ id: string; keyCipher: string }[]>;
    update(args: { where: { id: string }; data: { keyCipher: string } }): Promise<unknown>;
  };
  slackIntegration: {
    findMany(args: {
      select: { id: true; botToken: true };
    }): Promise<{ id: string; botToken: string }[]>;
    update(args: { where: { id: string }; data: { botToken: string } }): Promise<unknown>;
  };
}

export interface RotationDb {
  $transaction<T>(fn: (tx: RotationTx) => Promise<T>, options?: { timeout: number }): Promise<T>;
}

export interface RotationSummary {
  modelProviders: { rotated: number; alreadyRotated: number };
  slackIntegrations: { rotated: number; alreadyRotated: number };
}

async function rotateColumn<Row extends { id: string }>(
  table: string,
  rows: Row[],
  read: (row: Row) => string,
  write: (id: string, value: string) => Promise<unknown>,
  oldKeyHex: string,
  newKeyHex: string,
): Promise<{ rotated: number; alreadyRotated: number }> {
  let rotated = 0;
  let alreadyRotated = 0;
  for (const row of rows) {
    let result: RotatedValue;
    try {
      result = reencryptValue(read(row), oldKeyHex, newKeyHex);
    } catch {
      throw new EncryptionRotationError(
        `${table} row ${row.id} opens with neither the old nor the new key`,
      );
    }
    if (!result.rotated) {
      alreadyRotated += 1;
      continue;
    }
    await write(row.id, result.value);
    rotated += 1;
  }
  return { rotated, alreadyRotated };
}

/**
 * Re-encrypt every stored provider key and Slack token under `newKeyHex`, in one
 * transaction: any failure leaves the database exactly as it was. Safe to repeat.
 */
export async function rotateEncryptionKey(
  db: RotationDb,
  oldKeyHex: string,
  newKeyHex: string,
): Promise<RotationSummary> {
  if (!isValidKeyHex(oldKeyHex) || !isValidKeyHex(newKeyHex)) {
    throw new EncryptionRotationError("both keys must be 64-character hex strings (256 bits)");
  }
  if (oldKeyHex.toLowerCase() === newKeyHex.toLowerCase()) {
    throw new EncryptionRotationError("the new key must be different from the old key");
  }

  return db.$transaction(
    async (tx) => {
      const providers = await tx.modelProvider.findMany({ select: { id: true, keyCipher: true } });
      const modelProviders = await rotateColumn(
        "model_providers",
        providers,
        (row) => row.keyCipher,
        (id, keyCipher) => tx.modelProvider.update({ where: { id }, data: { keyCipher } }),
        oldKeyHex,
        newKeyHex,
      );

      const installs = await tx.slackIntegration.findMany({ select: { id: true, botToken: true } });
      const slackIntegrations = await rotateColumn(
        "slack_integrations",
        installs,
        (row) => row.botToken,
        (id, botToken) => tx.slackIntegration.update({ where: { id }, data: { botToken } }),
        oldKeyHex,
        newKeyHex,
      );

      // Read everything back inside the transaction; a row that does not open with
      // the new key aborts it.
      const newKey = Buffer.from(newKeyHex, "hex");
      for (const row of await tx.modelProvider.findMany({
        select: { id: true, keyCipher: true },
      })) {
        if (tryDecrypt(row.keyCipher, newKey) === null) {
          throw new EncryptionRotationError(`model_providers row ${row.id} failed verification`);
        }
      }
      for (const row of await tx.slackIntegration.findMany({
        select: { id: true, botToken: true },
      })) {
        if (tryDecrypt(row.botToken, newKey) === null) {
          throw new EncryptionRotationError(`slack_integrations row ${row.id} failed verification`);
        }
      }

      return { modelProviders, slackIntegrations };
    },
    { timeout: 300_000 },
  );
}
