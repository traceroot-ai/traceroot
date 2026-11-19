"use client";

import { ToastProvider } from "@/components/ui/toast";

/**
 * The real Evaluations pages reuse the offline-eval design components, which use
 * the toast system. Mount the provider for this route subtree, scoped so the
 * global stack is untouched.
 */
export default function EvaluationsLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
