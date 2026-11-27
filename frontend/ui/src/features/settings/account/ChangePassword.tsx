"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { authClient } from "@/lib/auth-client";
import { AuthError, AuthField, PasswordInput } from "@/components/auth/auth-layout";
import { Button } from "@/components/ui/button";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<number | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  async function submit(body: z.infer<typeof schema>) {
    setError(null);
    setEnded(null);
    try {
      const { data, error } = await authClient.changePassword({
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      if (error) {
        setError(error.message || "Could not change your password");
        return;
      }
      setEnded(
        (data as typeof data & { otherSessionsBeforeChange: number }).otherSessionsBeforeChange,
      );
      reset();
      onChanged();
    } catch {
      setError("Could not change your password. Check your connection and try again.");
    }
  }

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div>
        <h2 className="text-[15px] font-medium">Change password</h2>
        <p className="text-sm text-muted-foreground">
          All other sessions will be signed out. You will stay signed in on this device.
        </p>
      </div>
      {ended !== null && (
        <p role="status" className="text-sm">
          Password changed. All other sessions have been signed out ({ended} active before the
          change).
        </p>
      )}
      <form onSubmit={handleSubmit(submit)} className="max-w-sm space-y-4">
        <AuthError message={error} />
        <AuthField label="Current password" error={errors.currentPassword?.message}>
          <PasswordInput autoComplete="current-password" {...register("currentPassword")} />
        </AuthField>
        <AuthField label="New password" error={errors.newPassword?.message}>
          <PasswordInput autoComplete="new-password" {...register("newPassword")} />
        </AuthField>
        <AuthField label="Confirm password" error={errors.confirmPassword?.message}>
          <PasswordInput autoComplete="new-password" {...register("confirmPassword")} />
        </AuthField>
        <Button type="submit" variant="outline" size="sm" disabled={isSubmitting}>
          {isSubmitting ? "Changing password..." : "Change password"}
        </Button>
      </form>
    </section>
  );
}
