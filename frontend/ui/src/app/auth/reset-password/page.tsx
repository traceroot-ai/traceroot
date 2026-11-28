import { auth } from "@/lib/auth";
import { RequestNewLink, ResetPasswordClient } from "./reset-password-client";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const { token, error } = await searchParams;
  if (typeof token !== "string" || !token || error) return <RequestNewLink />;

  // The emailed link uses this read-only callback too. A bookmark can land
  // directly on the form after the link was used or expired.
  const callback = await auth.api.requestPasswordResetCallback({
    params: { token },
    query: { callbackURL: "/auth/reset-password" },
    asResponse: true,
  });
  const location = callback.headers.get("location");
  if (callback.status !== 302 || !location) throw new Error("Could not verify the reset link");
  const valid = new URL(location).searchParams.get("token") === token;
  return valid ? <ResetPasswordClient /> : <RequestNewLink />;
}
