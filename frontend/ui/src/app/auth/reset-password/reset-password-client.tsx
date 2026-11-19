"use client";

import { Suspense, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

const resetPasswordSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type ResetPasswordForm = z.infer<typeof resetPasswordSchema>;

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const errorParam = searchParams.get("error");

  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetPasswordForm>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const isInvalidToken = Boolean(errorParam === "INVALID_TOKEN" || (!token && !isSuccess));

  async function onSubmit(data: ResetPasswordForm) {
    if (!token) {
      setError("Reset token is missing. Please request a new password reset link.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const { error } = await authClient.resetPassword({
        newPassword: data.password,
        token,
      });

      if (error) {
        setError(error.message || "Failed to reset password");
      } else {
        setIsSuccess(true);
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
          <CardTitle className="text-[15px] font-medium">Set new password</CardTitle>
          {!isInvalidToken && !isSuccess && (
            <p className="text-[13px] text-muted-foreground">
              Please enter your new password below.
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
              {error}
            </div>
          )}

          {isSuccess ? (
            <div className="space-y-4 text-center">
              <div className="rounded border border-border bg-muted/40 p-3 text-[13px] text-muted-foreground">
                Your password has been successfully reset. You can now sign in with your new
                password.
              </div>
              <div className="pt-2">
                <Link href="/auth/sign-in" className="w-full">
                  <Button size="sm" className="h-8 w-full text-[13px]">
                    Sign in
                  </Button>
                </Link>
              </div>
            </div>
          ) : isInvalidToken ? (
            <div className="space-y-4 text-center">
              <div className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger">
                This password reset link is invalid or has expired. Please request a new one.
              </div>
              <div className="pt-2">
                <Link href="/auth/forgot-password" className="w-full">
                  <Button variant="outline" size="sm" className="h-8 w-full text-[13px]">
                    Request a new link
                  </Button>
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div>
                <label className="mb-1 block text-[13px] font-medium">New Password</label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="At least 8 characters"
                    className="h-8 pr-10 text-[13px]"
                    {...register("password")}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {errors.password && (
                  <p className="mt-1 text-[12px] text-danger">{errors.password.message}</p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-[13px] font-medium">Confirm Password</label>
                <div className="relative">
                  <Input
                    type={showConfirmPassword ? "text" : "password"}
                    placeholder="Repeat new password"
                    className="h-8 pr-10 text-[13px]"
                    {...register("confirmPassword")}
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {errors.confirmPassword && (
                  <p className="mt-1 text-[12px] text-danger">{errors.confirmPassword.message}</p>
                )}
              </div>

              <Button
                type="submit"
                size="sm"
                className="h-8 w-full text-[13px]"
                disabled={isLoading}
              >
                {isLoading ? "Resetting password..." : "Reset password"}
              </Button>

              <p className="text-center text-[12px] text-muted-foreground">
                <Link href="/auth/sign-in" className="font-medium text-brand hover:underline">
                  Back to sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ResetPasswordClient() {
  return (
    <Suspense>
      <ResetPasswordContent />
    </Suspense>
  );
}
