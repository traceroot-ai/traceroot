"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLayout,
  GoogleAuthOption,
  PasswordInput,
} from "@/components/auth/auth-layout";

const signInSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

type SignInForm = z.infer<typeof signInSchema>;

type SignInContentProps = {
  googleAuthConfigured: boolean;
  /** Only when SMTP is set up, since the reset link goes out by email. */
  passwordResetEnabled?: boolean;
};

function SignInContent({ googleAuthConfigured, passwordResetEnabled = false }: SignInContentProps) {
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
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

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

  async function handleGoogleSignIn() {
    setIsGoogleLoading(true);
    await authClient.signIn.social({
      provider: "google",
      callbackURL: callbackUrl,
    });
  }

  return (
    <AuthLayout>
      <AuthHeader
        title="Welcome back"
        subtitle="Sign in to traceroot to see your traces and agents."
      />
      {googleAuthConfigured && (
        <GoogleAuthOption onClick={handleGoogleSignIn} isLoading={isGoogleLoading} />
      )}
      <div className="space-y-5">
        <AuthError message={error} />

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <AuthField label="Email" error={errors.email?.message}>
            <Input
              type="email"
              placeholder="you@example.com"
              className="h-8 text-[13px]"
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
              className="h-8 text-[13px]"
              {...register("password")}
            />
          </AuthField>

          <Button type="submit" size="sm" className="h-8 w-full text-[13px]" disabled={isLoading}>
            {isLoading ? "Signing in..." : "Sign in"}
          </Button>
        </form>
      </div>
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
