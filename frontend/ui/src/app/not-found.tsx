// app/not-found.tsx

import { cn } from "@/lib/utils";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="mb-4 text-6xl font-bold text-foreground">404</h1>
        <h2 className="mb-4 text-2xl text-foreground">Page Not Found</h2>

        <p className="mb-8 text-muted-foreground">The page you are looking for does not exist.</p>
        <Link
          href="/"
          className={cn(
            "inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground",
            "transition-colors hover:bg-primary/90",
          )}
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
