"use client";

import { useState } from "react";
import { FaGithub } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { EnabledSocialAuthProviders, SocialAuthProvider } from "@/lib/social-auth";

type SocialAuthButtonsProps = {
  callbackURL: string;
  enabledProviders: EnabledSocialAuthProviders;
  onError: (message: string | null) => void;
  verb: "sign in" | "sign up";
};

const providerLabels: Record<SocialAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};

export function SocialAuthButtons({
  callbackURL,
  enabledProviders,
  onError,
  verb,
}: SocialAuthButtonsProps) {
  const [loadingProvider, setLoadingProvider] = useState<SocialAuthProvider | null>(null);
  const hasSocialProviders = enabledProviders.google || enabledProviders.github;

  if (!hasSocialProviders) {
    return null;
  }

  async function handleSocialAuth(provider: SocialAuthProvider) {
    const label = providerLabels[provider];
    setLoadingProvider(provider);
    onError(null);

    try {
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL,
      });
      if (error) {
        onError(error.message || `Failed to ${verb} with ${label}`);
        setLoadingProvider(null);
      }
    } catch {
      onError("An unexpected error occurred");
      setLoadingProvider(null);
    }
  }

  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-[11px] uppercase">
          <span className="bg-card px-2 text-muted-foreground">Or</span>
        </div>
      </div>

      <div className="space-y-2">
        {enabledProviders.google && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full text-[13px]"
            onClick={() => handleSocialAuth("google")}
            disabled={loadingProvider !== null}
          >
            {loadingProvider === "google" ? "Redirecting..." : "Continue with Google"}
          </Button>
        )}

        {enabledProviders.github && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full gap-2 text-[13px]"
            onClick={() => handleSocialAuth("github")}
            disabled={loadingProvider !== null}
          >
            <FaGithub className="h-[15px] w-[15px]" aria-hidden="true" />
            {loadingProvider === "github" ? "Redirecting..." : "Continue with GitHub"}
          </Button>
        )}
      </div>
    </>
  );
}
