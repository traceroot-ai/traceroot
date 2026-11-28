import { notFound } from "next/navigation";
import { isLoopsEnabled } from "@/lib/loops-enabled";

// Every Loop page is not found while LOOPS_ENABLED is off (lib/loops-enabled.ts).
export default function LoopsLayout({ children }: { children: React.ReactNode }) {
  if (!isLoopsEnabled()) notFound();
  return children;
}
