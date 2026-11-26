"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useHydrated } from "@/app/auth/use-hydrated";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AgentIdNote,
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLayout,
  AuthProviderOptions,
  PasswordInput,
} from "@/components/auth/auth-layout";
import type { SocialProvider } from "@/lib/social-providers";
import { useSocialSignIn } from "../use-social-sign-in";
import { ClientVerifiedBy, UnverifiedClientNotice } from "@/features/oauth-connect";
import type { OAuthClientDisplay } from "@/lib/oauth/client-display";

const signInSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

type SignInForm = z.infer<typeof signInSchema>;

type SignInContentProps = {
  socialProviders: SocialProvider[];
  /** Only when SMTP is set up, since the reset link goes out by email. */
  passwordResetEnabled?: boolean;
  // Set when this sign-in is part of connecting an assistant (lib/oauth/client-display).
  connection?: OAuthClientDisplay | null;
};

function SignInContent({
  socialProviders,
  passwordResetEnabled = false,
  connection = null,
}: SignInContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Attacker-suppliable query param; only same-origin destinations may pass.
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  // Preserve the callback when switching to sign-up so a new user finishes the
  // same round-trip (e.g. a device login returns to /device to approve).
  const signUpHref =
    callbackUrl && callbackUrl !== "/"
      ? `/auth/sign-up?callbackUrl=${encodeURIComponent(callbackUrl)}`
      : "/auth/sign-up";
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const hydrated = useHydrated();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInForm>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(data: SignInForm) {
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await authClient.signIn.email({
        email: data.email,
        password: data.password,
      });
      if (error) {
        setError(error.message || "Invalid credentials");
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  const social = useSocialSignIn(socialProviders, callbackUrl, setError);

  const field = "h-10 pl-[13px] text-[14px]";

  return (
    <AuthLayout>
      <AuthHeader
        title={connection ? `Sign in to connect ${connection.name}` : "Welcome back"}
        subtitle="Sign in to traceroot to see your traces and agents."
      />
      {connection && (
        <div className="mb-5 space-y-2">
          <ClientVerifiedBy client={connection} />
          <UnverifiedClientNotice client={connection} />
        </div>
      )}
      <AuthProviderOptions social={social} />
      <div className="space-y-5">
        <AuthError message={error} />

        <form method="post" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <AuthField label="Email" error={errors.email?.message}>
              <Input
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                className={field}
                {...register("email")}
              />
            </AuthField>

            <AuthField
              label="Password"
              error={errors.password?.message}
              action={
                passwordResetEnabled && (
                  <Link
                    href="/auth/forgot-password"
                    className="text-[12px] text-brand hover:underline"
                  >
                    Forgot?
                  </Link>
                )
              }
            >
              <PasswordInput
                placeholder="********"
                autoComplete="current-password"
                className={field}
                {...register("password")}
              />
            </AuthField>
          </div>

          <Button
            type="submit"
            size="sm"
            className="mt-6 h-10 w-full text-[14px] font-[600] text-primary-ink"
            disabled={isLoading || !hydrated}
          >
            {isLoading ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
      <AgentIdNote intent="sign-in" social={social} className="mt-4" />
      <AuthFooter>
        Don&apos;t have an account?{" "}
        <Link href={signUpHref} className="font-medium text-brand hover:underline">
          Sign up
        </Link>
      </AuthFooter>
    </AuthLayout>
  );
}

export function SignInClient(props: SignInContentProps) {
  return (
    <Suspense>
      <SignInContent {...props} />
    </Suspense>
  );
}
