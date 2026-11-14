"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthError,
  AuthField,
  AuthFooter,
  AuthHeader,
  AuthLayout,
} from "@/components/auth/auth-layout";

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email"),
});

type ForgotPasswordForm = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordClient() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordForm>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(data: ForgotPasswordForm) {
    setIsLoading(true);
    setError(null);
    try {
      const { error } = await authClient.requestPasswordReset({
        email: data.email,
        redirectTo: "/auth/reset-password",
      });
      if (error) {
        setError(error.message || "Could not send the reset link");
      } else {
        setSentTo(data.email);
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  const backToSignIn = (
    <AuthFooter showLegal={false}>
      Remembered it?{" "}
      <Link href="/auth/sign-in" className="font-medium text-brand hover:underline">
        Back to sign in
      </Link>
    </AuthFooter>
  );

  if (sentTo) {
    return (
      <AuthLayout>
        <AuthHeader
          title="Check your email"
          subtitle={`If an account exists for ${sentTo}, we sent a link to reset your password. It expires in 1 hour.`}
        />
        {backToSignIn}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeader
        title="Reset your password"
        subtitle="Enter your account email and we'll send you a reset link."
      />
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
          <Button type="submit" size="sm" className="h-8 w-full text-[13px]" disabled={isLoading}>
            {isLoading ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      </div>
      {backToSignIn}
    </AuthLayout>
  );
}
