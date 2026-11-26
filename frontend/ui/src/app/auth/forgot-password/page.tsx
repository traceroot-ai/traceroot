import { redirect } from "next/navigation";
import { isSmtpConfigured } from "@/lib/email/send-password-reset-email";
import { ForgotPasswordClient } from "./forgot-password-client";

export const dynamic = "force-dynamic";

// The reset link goes out by email, so without SMTP there is nothing to request.
export default function ForgotPasswordPage() {
  if (!isSmtpConfigured()) redirect("/auth/sign-in");
  return <ForgotPasswordClient />;
}
