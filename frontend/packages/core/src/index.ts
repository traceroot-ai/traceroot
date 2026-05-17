// Database
export { prisma } from "./lib/prisma.js";
export { PrismaClient } from "@prisma/client";
export * from "./ee/billing/index.js";

// Encryption
export { encryptKey, decryptKey, maskKey } from "./lib/encryption.js";

// BYOK key resolution
export { resolveWorkspaceApiKey } from "./lib/workspace-api-key.js";

// Re-export Prisma types
export type {
  User,
  Workspace,
  WorkspaceMember,
  Project,
  AccessKey,
  Invite,
  Account,
  GitHubInstallation,
  ModelProvider,
} from "@prisma/client";

// Constants & Zod schemas
export * from "./constants.js";
export * from "./schemas.js";

// LLM Providers
export * from "./llm-providers.js";

// Model Pricing (DB-backed)
export * from "./model-pricing/index.js";

// Shared types
export * from "./types/index.js";

// NOTE: pi-ai Model resolver lives at `@traceroot/core/model-resolver` (subpath).
// We do NOT re-export it here — pulling pi-ai into the main barrel would bundle
// Node-only code (`node:fs`, etc.) into the Next.js client. Server-side
// consumers (agent, detector worker) import explicitly from the subpath.
