"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function ConfirmContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const code = searchParams.get("code");
  const installationId = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action");

  if (!code) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-lg font-semibold text-red-600">Invalid Link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-center">
            <p className="text-[13px] text-muted-foreground">
              This confirmation link is missing required parameters or has expired.
            </p>
            <Button
              variant="outline"
              className="h-8 w-full text-[13px]"
              onClick={() => router.push("/")}
            >
              Return to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  async function handleConfirm() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/github/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, installationId, setupAction }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to link account");
      }

      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
      } else {
        router.push("/");
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred");
      setIsLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Image
            src="/images/traceroot_icon.png"
            alt="TraceRoot"
            width={48}
            height={48}
            className="mx-auto mb-4"
          />
          <CardTitle className="text-lg font-semibold">Confirm Account Link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-center text-[13px] text-muted-foreground">
            You are about to link a GitHub account provided by a direct installation to your
            Traceroot account. Do you want to proceed?
          </p>

          {error && (
            <div className="border border-red-200 bg-red-50 p-3 text-[12px] text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2">
            <Button
              size="sm"
              className="h-8 w-full text-[13px]"
              onClick={handleConfirm}
              disabled={isLoading}
            >
              {isLoading ? "Linking Account..." : "Confirm & Link"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full text-[13px]"
              onClick={() => router.push("/")}
              disabled={isLoading}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function GitHubConfirmPage() {
  return (
    <Suspense>
      <ConfirmContent />
    </Suspense>
  );
}
