// Database
export { prisma } from "./lib/prisma.ts";
export { PrismaClient } from "@prisma/client";
export * from "./ee/billing/index.ts";

// Encryption
export { encryptKey, decryptKey, maskKey } from "./lib/encryption.ts";

// BYOK key resolution
export { resolveWorkspaceApiKey } from "./lib/workspace-api-key.ts";

// Transactional-email card template
export { escapeHtml, renderEmailCard } from "./lib/email-card.ts";

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
export * from "./constants.ts";
export * from "./schemas.ts";

// LLM Providers
export * from "./llm-providers.ts";

// Model Pricing (DB-backed)
export * from "./model-pricing/index.ts";

// Shared types
export * from "./types/index.ts";

// NOTE: pi-ai Model resolver lives at `@traceroot/core/model-resolver` (subpath).
// We do NOT re-export it here — pulling pi-ai into the main barrel would bundle
// Node-only code (`node:fs`, etc.) into the Next.js client. Server-side
// consumers (agent, detector worker) import explicitly from the subpath.
