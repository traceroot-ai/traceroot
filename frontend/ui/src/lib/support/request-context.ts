import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "@/lib/auth";
import type { impersonationContext } from "./session";

// Request-local (never a process-global employee identity).
export const supportRequest = new AsyncLocalStorage<{
  session: Session | null;
  impersonation: Awaited<ReturnType<typeof impersonationContext>>;
}>();
