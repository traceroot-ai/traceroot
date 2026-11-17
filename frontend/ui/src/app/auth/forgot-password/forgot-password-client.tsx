"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email"),
});

type ForgotPasswordForm = z.infer<typeof forgotPasswordSchema>;

function ForgotPasswordContent() {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState("");

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
        setError(error.message || "Failed to send reset link");
      } else {
        setIsSubmitted(true);
        setSubmittedEmail(data.email);
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo size="lg" />
          </div>
          <CardTitle className="text-[15px] font-medium">Reset your password</CardTitle>
          <p className="text-[13px] text-muted-foreground">
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
              {error}
            </div>
          )}

          {isSubmitted ? (
            <div className="space-y-4 text-center">
              <div className="rounded border border-border bg-muted/40 p-3 text-[13px] text-muted-foreground">
                If an account exists for{" "}
                <strong className="text-foreground">{submittedEmail}</strong>, you will receive a
                password reset link shortly.
              </div>
              <p className="text-[12px] text-muted-foreground">
                Didn&apos;t receive an email? Check your spam folder or try again.
              </p>
              <div className="pt-2">
                <Link href="/auth/sign-in" className="w-full">
                  <Button variant="outline" size="sm" className="h-8 w-full text-[13px]">
                    Back to sign in
                  </Button>
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="mb-1 block text-[13px] font-medium">Email</label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  className="h-8 text-[13px]"
                  {...register("email")}
                />
                {errors.email && (
                  <p className="mt-1 text-[12px] text-danger">{errors.email.message}</p>
                )}
              </div>

              <Button
                type="submit"
                size="sm"
                className="h-8 w-full text-[13px]"
                disabled={isLoading}
              >
                {isLoading ? "Sending link..." : "Send reset link"}
              </Button>

              <p className="text-center text-[12px] text-muted-foreground">
                Remember your password?{" "}
                <Link href="/auth/sign-in" className="font-medium text-brand hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ForgotPasswordClient() {
  return (
    <Suspense>
      <ForgotPasswordContent />
    </Suspense>
  );
}
