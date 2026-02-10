// Load environment variables from core's .env
import "./env.js";

// Database
export { prisma } from "./lib/prisma.js";
export { PrismaClient } from "@prisma/client";
export * from "./billing/index.js";

// Re-export Prisma types
export type {
  User,
  Workspace,
  WorkspaceMember,
  Project,
  AccessKey,
  Invite,
  Account,
} from "@prisma/client";

// Shared types
export * from "./types/index.js";                                    