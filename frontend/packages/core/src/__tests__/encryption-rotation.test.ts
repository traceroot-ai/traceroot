import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "../lib/encryption.ts";
import {
  EncryptionRotationError,
  reencryptValue,
  rotateEncryptionKey,
  type RotationDb,
} from "../lib/encryption-rotation.ts";

const OLD_KEY = "a".repeat(64);
const NEW_KEY = "b".repeat(64);

function withKey<T>(hex: string, fn: () => T): T {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = hex;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
}

const sealUnder = (hex: string, plaintext: string) => withKey(hex, () => encryptKey(plaintext));
const openUnder = (hex: string, cipher: string) => withKey(hex, () => decryptKey(cipher));

/** In-memory stand-in for the two tables, with transaction rollback. */
function fakeDb(
  providers: { id: string; keyCipher: string }[],
  slack: { id: string; botToken: string }[],
) {
  const state = {
    providers: providers.map((r) => ({ ...r })),
    slack: slack.map((r) => ({ ...r })),
  };
  const db: RotationDb = {
    async $transaction(fn) {
      const snapshot = {
        providers: state.providers.map((r) => ({ ...r })),
        slack: state.slack.map((r) => ({ ...r })),
      };
      try {
        return await fn({
          modelProvider: {
            findMany: async () => state.providers.map((r) => ({ ...r })),
            update: async ({ where, data }) => {
              const row = state.providers.find((r) => r.id === where.id)!;
              row.keyCipher = data.keyCipher;
            },
          },
          slackIntegration: {
            findMany: async () => state.slack.map((r) => ({ ...r })),
            update: async ({ where, data }) => {
              const row = state.slack.find((r) => r.id === where.id)!;
              row.botToken = data.botToken;
            },
          },
        });
      } catch (error) {
        state.providers = snapshot.providers;
        state.slack = snapshot.slack;
        throw error;
      }
    },
  };
  return { db, state };
}

describe("reencryptValue", () => {
  it("moves a value from the old key to the new key", () => {
    const cipher = sealUnder(OLD_KEY, "sk-secret");
    const result = reencryptValue(cipher, OLD_KEY, NEW_KEY);
    expect(result.rotated).toBe(true);
    expect(openUnder(NEW_KEY, result.value)).toBe("sk-secret");
    expect(() => openUnder(OLD_KEY, result.value)).toThrow();
  });

  it("leaves a value that already uses the new key alone", () => {
    const cipher = sealUnder(NEW_KEY, "sk-secret");
    const result = reencryptValue(cipher, OLD_KEY, NEW_KEY);
    expect(result).toEqual({ value: cipher, rotated: false });
  });

  it("rejects a value that neither key opens, without echoing it", () => {
    const cipher = sealUnder("c".repeat(64), "sk-secret");
    expect(() => reencryptValue(cipher, OLD_KEY, NEW_KEY)).toThrow(EncryptionRotationError);
    try {
      reencryptValue(cipher, OLD_KEY, NEW_KEY);
    } catch (error) {
      expect(String(error)).not.toContain(cipher);
      expect(String(error)).not.toContain("sk-secret");
    }
  });
});

describe("rotateEncryptionKey", () => {
  it("rotates both tables and reports counts", async () => {
    const { db, state } = fakeDb(
      [
        { id: "p1", keyCipher: sealUnder(OLD_KEY, "provider-1") },
        { id: "p2", keyCipher: sealUnder(OLD_KEY, "provider-2") },
      ],
      [{ id: "s1", botToken: sealUnder(OLD_KEY, "xoxb-1") }],
    );
    const summary = await rotateEncryptionKey(db, OLD_KEY, NEW_KEY);
    expect(summary).toEqual({
      modelProviders: { rotated: 2, alreadyRotated: 0 },
      slackIntegrations: { rotated: 1, alreadyRotated: 0 },
    });
    expect(openUnder(NEW_KEY, state.providers[0].keyCipher)).toBe("provider-1");
    expect(openUnder(NEW_KEY, state.providers[1].keyCipher)).toBe("provider-2");
    expect(openUnder(NEW_KEY, state.slack[0].botToken)).toBe("xoxb-1");
  });

  it("is a no-op on empty tables", async () => {
    const { db } = fakeDb([], []);
    const summary = await rotateEncryptionKey(db, OLD_KEY, NEW_KEY);
    expect(summary.modelProviders.rotated + summary.slackIntegrations.rotated).toBe(0);
  });

  it("can be run again after it finished", async () => {
    const { db } = fakeDb([{ id: "p1", keyCipher: sealUnder(OLD_KEY, "provider-1") }], []);
    await rotateEncryptionKey(db, OLD_KEY, NEW_KEY);
    const second = await rotateEncryptionKey(db, OLD_KEY, NEW_KEY);
    expect(second.modelProviders).toEqual({ rotated: 0, alreadyRotated: 1 });
  });

  it("changes nothing when one row cannot be opened", async () => {
    const good = sealUnder(OLD_KEY, "provider-1");
    const { db, state } = fakeDb(
      [
        { id: "p1", keyCipher: good },
        { id: "p2", keyCipher: "not-a-cipher" },
      ],
      [],
    );
    await expect(rotateEncryptionKey(db, OLD_KEY, NEW_KEY)).rejects.toThrow(/model_providers.*p2/);
    expect(state.providers[0].keyCipher).toBe(good);
    expect(state.providers[1].keyCipher).toBe("not-a-cipher");
  });

  it("rejects malformed or identical keys before touching data", async () => {
    const { db } = fakeDb([], []);
    await expect(rotateEncryptionKey(db, "short", NEW_KEY)).rejects.toThrow(/64-character/);
    await expect(rotateEncryptionKey(db, OLD_KEY, "zz".repeat(32))).rejects.toThrow(/64-character/);
    await expect(rotateEncryptionKey(db, OLD_KEY, OLD_KEY)).rejects.toThrow(/different/);
  });
});
