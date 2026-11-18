// One-time move of stored provider keys and Slack tokens to a new encryption key.
// Run through `make rotate-encryption-key`. Reads OLD_ENCRYPTION_KEY and
// NEW_ENCRYPTION_KEY from the environment; prints counts only, never key or value text.
import { PrismaClient } from "@prisma/client";
import { EncryptionRotationError, rotateEncryptionKey } from "../src/lib/encryption-rotation.ts";

const oldKey = process.env.OLD_ENCRYPTION_KEY ?? "";
const newKey = process.env.NEW_ENCRYPTION_KEY ?? "";
const prisma = new PrismaClient();

try {
  const summary = await rotateEncryptionKey(prisma, oldKey, newKey);
  const { modelProviders: providers, slackIntegrations: slack } = summary;
  console.log(
    `rotate-encryption-key: model providers re-encrypted ${providers.rotated}, already on the new key ${providers.alreadyRotated}; ` +
      `Slack installs re-encrypted ${slack.rotated}, already on the new key ${slack.alreadyRotated}`,
  );
} catch (error) {
  const reason = error instanceof EncryptionRotationError ? error.message : "database error";
  console.error(`rotate-encryption-key: failed, nothing was changed (${reason})`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
