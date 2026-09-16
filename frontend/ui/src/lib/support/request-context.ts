import { AsyncLocalStorage } from "node:async_hooks";

// Request-local (never a process-global employee identity).
export const supportRequest = new AsyncLocalStorage<{ sessionId: string }>();
