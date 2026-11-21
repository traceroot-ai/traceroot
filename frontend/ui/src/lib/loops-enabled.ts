import { env } from "@/env";

/**
 * Whether Loops are switched on for this deployment: LOOPS_ENABLED is "true"
 * (trimmed, any case). When off, their API routes answer 404 and the pricing
 * lists leave Loops out. Read on the server; the root layout hands it to client code.
 */
export function isLoopsEnabled(): boolean {
  return env.LOOPS_ENABLED.trim().toLowerCase() === "true";
}
