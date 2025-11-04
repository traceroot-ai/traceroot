"use client";

import { SignIn } from "@clerk/nextjs";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center space-y-4">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight">
              Welcome to TraceRoot.AI
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to continue
            </p>
          </div>

          <SignIn
            appearance={{
              elements: {
                rootBox: "w-full",
                card: "shadow-none border-0 bg-transparent",
              },
            }}
            routing="hash"
            afterSignInUrl="/explore"
            afterSignUpUrl="/explore"
          />
        </div>
      </div>
    </div>
  );
}
