"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { authClient } from "@/lib/auth-client";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLayout,
  PasswordInput,
} from "@/components/auth/auth-layout";

const resetPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;

function SignInFooter({ label }: { label: string }) {
  return (
    <AuthFooter showLegal={false}>
      <Link href="/auth/sign-in" className="font-medium text-brand hover:underline">
        {label}
      </Link>
    </AuthFooter>
  );
}

function RequestNewLink() {
  return (
    <AuthLayout>
      <AuthHeader
        title="This link has expired"
        subtitle="Reset links work once and expire after 1 hour. Request a new one to continue."
      />
      <Link
        href="/auth/forgot-password"
        className={cn(buttonVariants({ size: "sm" }), "h-8 w-full text-[13px]")}
      >
        Request a new link
      </Link>
      <SignInFooter label="Back to sign in" />
    </AuthLayout>
  );
}

function ResetPasswordContent() {
  // better-auth checks the emailed token, then lands here with ?token= when it
  // is valid or ?error=INVALID_TOKEN when it is not.
  const token = useSearchParams().get("token");
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  if (!token || expired) return <RequestNewLink />;
  const resetToken = token;

  async function onSubmit(data: ResetPasswordForm) {
    setIsLoading(true);
    setError(null);
    try {
      const { error } = await authClient.resetPassword({
        newPassword: data.password,
        token: resetToken,
      });
      if (error?.code === "INVALID_TOKEN") {
        setExpired(true);
      } else if (error) {
        setError(error.message || "Could not reset your password");
      } else {
        setDone(true);
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  if (done) {
    return (
      <AuthLayout>
        <AuthHeader
          title="Password updated"
          subtitle="Sign in with your new password. Other devices have been signed out."
        />
        <Link
          href="/auth/sign-in"
          className={cn(buttonVariants({ size: "sm" }), "h-8 w-full text-[13px]")}
        >
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeader
        title="Set a new password"
        subtitle="Choose a password of at least 8 characters."
      />
      <div className="space-y-5">
        <AuthError message={error} />
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <AuthField label="New password" error={errors.password?.message}>
            <PasswordInput
              placeholder="********"
              autoComplete="new-password"
              className="h-8 text-[13px]"
              {...register("password")}
            />
          </AuthField>
          <AuthField label="Confirm password" error={errors.confirmPassword?.message}>
            <PasswordInput
              placeholder="********"
              autoComplete="new-password"
              className="h-8 text-[13px]"
              {...register("confirmPassword")}
            />
          </AuthField>
          <Button type="submit" size="sm" className="h-8 w-full text-[13px]" disabled={isLoading}>
            {isLoading ? "Saving..." : "Reset password"}
          </Button>
        </form>
      </div>
      <SignInFooter label="Back to sign in" />
    </AuthLayout>
  );
}

export function ResetPasswordClient() {
  return (
    <Suspense>
      <ResetPasswordContent />
    </Suspense>
  );
}
