// Database
export { prisma } from "./lib/prisma";
export { PrismaClient } from "@prisma/client";
export * from "./ee/billing/index";

// Encryption
export { encryptKey, decryptKey, maskKey } from "./lib/encryption";

// BYOK key resolution
export { resolveWorkspaceApiKey } from "./lib/workspace-api-key";

// Re-export Prisma types
export type {
  User,
  Workspace,
  WorkspaceMember,
  Project,
  AccessKey,
  Invite,
  Account,
  GitHubConnection,
  ModelProvider,
} from "@prisma/client";

// Constants & Zod schemas
export * from "./constants";
export * from "./schemas";

// LLM Providers
export * from "./llm-providers";

// Model Pricing (DB-backed)
export * from "./model-pricing";

// Shared types
export * from "./types/index";
