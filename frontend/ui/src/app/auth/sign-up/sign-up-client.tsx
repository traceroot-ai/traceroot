"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
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
import { signupEmailError } from "@/lib/signup/email-policy";

const signUpSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.string().email("Invalid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

const cloudSignUpSchema = signUpSchema.superRefine(({ email }, ctx) => {
  const error = signupEmailError(email);
  if (error) ctx.addIssue({ code: "custom", message: error.message, path: ["email"] });
});
type SignUpForm = z.infer<typeof signUpSchema>;

type SignUpClientProps = {
  googleAuthConfigured: boolean;
  emailDomainPolicyEnabled: boolean;
};

// A brand-new account always finishes at onboarding. The one thing that can
// need to happen first is a pending device authorization — the CLI login flow
// sends the user through /device before they sign up. Onboarding runs *before*
// that approval, not after: approving releases the waiting terminal, and the
// CLI's very next call asks which project to use. Approve first and it reads an
// account that owns nothing, because the workspace does not exist until a human
// submits the form on the page it was about to be sent to. So onboarding comes
// first and carries the device URL as its callback. Anything else goes straight
// to onboarding; a new user shouldn't be dropped deep in the app.
//
// This is a shortcut, not the enforcement, and the difference matters because
// both buttons below share this destination while only one of them is a sign-up:
// `signIn.social` is better-auth's only social entry point, so Google here signs
// an existing account straight in, and account linking makes it answer for an
// existing email account at the same address too. Those land on onboarding
// without being new. /onboarding and /device each check the account rather than
// the route, so a wrong guess here normally costs a redirect rather than a
// second workspace — normally, because /onboarding deliberately falls through to
// its form when that lookup *fails* (a new account that cannot reach the form
// could never finish signing up), and a wrong guess plus a failed lookup is the
// one case where an existing account is offered the duplicate. What the guess
// buys is two fewer navigations on the common path: a genuine new account goes
// straight to the form instead of touching /device first only to be sent back.
function postSignUpDestination(callbackUrl: string): string {
  // Match the /device path exactly, not by prefix: a startsWith check would also
  // catch an unrelated future route like /device-settings and wrongly funnel a
  // new account into the device-authorization flow.
  const [path] = callbackUrl.split("?");
  if (path !== "/device") {
    return "/onboarding";
  }
  return `/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}

function SignUpContent({ googleAuthConfigured, emailDomainPolicyEnabled }: SignUpClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Attacker-suppliable query param; only same-origin destinations may pass.
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));
  const destination = postSignUpDestination(callbackUrl);
  const signInHref =
    callbackUrl !== "/"
      ? `/auth/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`
      : "/auth/sign-in";
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignUpForm>({
    resolver: zodResolver(emailDomainPolicyEnabled ? cloudSignUpSchema : signUpSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  async function onSubmit(data: SignUpForm) {
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await authClient.signUp.email({
        name: data.name,
        email: data.email,
        password: data.password,
      });
      if (error) {
        setError(error.message || "Failed to create account");
      } else {
        router.push(destination);
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleGoogleSignUp() {
    setIsGoogleLoading(true);
    await authClient.signIn.social({
      provider: "google",
      callbackURL: destination,
    });
  }

  return (
    <AuthLayout>
      <AuthHeader
        title="Create your account"
        subtitle="Start tracing and improving your AI agents."
      />
      {googleAuthConfigured && (
        <GoogleAuthOption onClick={handleGoogleSignUp} isLoading={isGoogleLoading} />
      )}
      <div className="space-y-5">
        <AuthError message={error} />

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <AuthField label="Name" error={errors.name?.message}>
            <Input placeholder="John Doe" className="h-8 text-[13px]" {...register("name")} />
          </AuthField>

          <AuthField label="Email" error={errors.email?.message}>
            <Input
              type="email"
              placeholder="you@example.com"
              className="h-8 text-[13px]"
              {...register("email")}
            />
          </AuthField>

          <AuthField label="Password" error={errors.password?.message}>
            <PasswordInput
              placeholder="********"
              autoComplete="new-password"
              className="h-8 text-[13px]"
              {...register("password")}
            />
          </AuthField>

          <AuthField label="Confirm Password" error={errors.confirmPassword?.message}>
            <PasswordInput
              placeholder="********"
              autoComplete="new-password"
              className="h-8 text-[13px]"
              {...register("confirmPassword")}
            />
          </AuthField>

          <Button type="submit" size="sm" className="h-8 w-full text-[13px]" disabled={isLoading}>
            {isLoading ? "Creating account..." : "Sign up"}
          </Button>
        </form>
      </div>
      <AuthFooter>
        Already have an account?{" "}
        <Link href={signInHref} className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </AuthFooter>
    </AuthLayout>
  );
}

export function SignUpClient(props: SignUpClientProps) {
  return (
    <Suspense>
      <SignUpContent {...props} />
    </Suspense>
  );
}
