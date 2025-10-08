"use client";

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center">
        <SignIn
          appearance={{
            elements: {
              rootBox: "mx-auto",
              card: "shadow-lg",
            },
          }}
        />
        <div className="mt-4 text-center text-sm text-muted-foreground">
          Need to access the legacy system?{" "}
          <a
            href="https://auth.traceroot.ai/"
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Legacy login
          </a>
        </div>
      </div>
    </div>
  );
}
