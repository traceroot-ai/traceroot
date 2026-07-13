"use client";

import { ToastProvider } from "@/components/ui/toast";

/**
 * The real Datasets pages reuse the offline-eval design components (drawers,
 * panels, case editors) which surface feedback through the toast system. Mount
 * the provider for this route subtree, mirroring how the prototype scopes it —
 * the global provider stack stays untouched.
 */
export default function DatasetsLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
