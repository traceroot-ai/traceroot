// Database
export { prisma } from "./lib/prisma.js";
export { PrismaClient } from "@prisma/client";

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