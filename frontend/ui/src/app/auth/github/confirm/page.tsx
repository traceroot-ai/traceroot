"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";

function ConfirmContent() {
  const router = useRouter();
  const t = useT();
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
            <CardTitle className="text-[15px] font-medium text-danger">
              {t("githubConfirm.invalidTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-center">
            <p className="text-[13px] text-muted-foreground">{t("githubConfirm.invalidText")}</p>
            <Button
              variant="outline"
              className="h-8 w-full text-[13px]"
              onClick={() => router.push("/")}
            >
              {t("githubConfirm.returnToDashboard")}
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
        body: JSON.stringify({ code, installationId }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("githubConfirm.failed"));
      }

      if (data.redirectUrl) {
        // Guard against open redirects, we should only redirect to the same origin
        try {
          const redirectUrl = new URL(data.redirectUrl);
          if (redirectUrl.origin !== window.location.origin) {
            console.error("Unexpected redirect origin, falling back to home.");
            setIsLoading(false);
            router.push("/");
          } else {
            window.location.href = data.redirectUrl;
          }
        } catch {
          setIsLoading(false);
          router.push("/");
        }
      } else {
        router.push("/");
      }
    } catch (err: any) {
      setError(translateClientError(t, err.message) || t("auth.errorUnexpected"));
      setIsLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Image
            src="/images/traceroot_icon.png"
            alt="traceroot"
            width={48}
            height={48}
            className="mx-auto mb-4"
          />
          <CardTitle className="text-[15px] font-medium">{t("githubConfirm.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-center text-[13px] text-muted-foreground">{t("githubConfirm.text")}</p>

          {error && (
            <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
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
              {isLoading ? t("githubConfirm.linking") : t("shellCommon.confirm")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full text-[13px]"
              onClick={() => router.push("/")}
              disabled={isLoading}
            >
              {t("common.cancel")}
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
