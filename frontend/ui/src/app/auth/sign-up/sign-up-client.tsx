"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AgentIdNote,
  AuthError,
  AuthField,
  AuthHeader,
  AuthLayout,
  AuthLegal,
  AuthProviderOptions,
  PasswordInput,
} from "@/components/auth/auth-layout";
import { signupEmailError } from "@/lib/signup/email-policy";
import type { SocialProvider } from "@/lib/social-providers";
import { useSocialSignIn } from "../use-social-sign-in";

// The password is asked for once; the show/hide toggle is how to check it.
const signUpSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const cloudSignUpSchema = signUpSchema.superRefine(({ email }, ctx) => {
  const error = signupEmailError(email);
  if (error) ctx.addIssue({ code: "custom", message: error.message, path: ["email"] });
});
type SignUpForm = z.infer<typeof signUpSchema>;

type SignUpClientProps = {
  socialProviders: SocialProvider[];
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
// the form and the social buttons below share this destination while only the
// form is always a sign-up: `signIn.social` is better-auth's only social entry
// point, so Google or AgentID here signs an existing account straight in, and
// account linking (Google only) makes Google answer for an existing email
// account at the same address too. Those land on onboarding without being new.
// /onboarding and /device each check the account rather than
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

function SignUpContent({ socialProviders, emailDomainPolicyEnabled }: SignUpClientProps) {
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

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignUpForm>({
    resolver: zodResolver(emailDomainPolicyEnabled ? cloudSignUpSchema : signUpSchema),
    defaultValues: { name: "", email: "", password: "" },
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

  const social = useSocialSignIn(socialProviders, destination, setError);

  const field = "h-10 pl-[13px] text-[14px]";

  return (
    <AuthLayout
      topAction={
        <>
          <span className="hidden text-[13px] text-muted-foreground min-[400px]:inline">
            Already have an account?
          </span>
          <Link
            href={signInHref}
            className={buttonVariants({ variant: "outline", size: "sm", className: "h-8 px-3" })}
          >
            Sign in
          </Link>
        </>
      }
    >
      <AuthHeader
        title="Create your account"
        subtitle="Start tracing and improving your AI agents."
      />
      <AuthProviderOptions social={social} />
      <div className="space-y-5">
        <AuthError message={error} />

        <form method="post" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <AuthField label="Name" error={errors.name?.message}>
              <Input
                placeholder="Your name"
                autoComplete="name"
                className={field}
                {...register("name")}
              />
            </AuthField>

            <AuthField label="Email" error={errors.email?.message}>
              <Input
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                className={field}
                {...register("email")}
              />
            </AuthField>

            <AuthField label="Password" error={errors.password?.message}>
              <PasswordInput
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className={field}
                {...register("password")}
              />
            </AuthField>
          </div>

          <Button
            type="submit"
            size="sm"
            className="mt-6 h-10 w-full text-[14px] font-[600] text-primary-ink"
            disabled={isLoading}
          >
            {isLoading ? "Creating account..." : "Sign up"}
          </Button>
        </form>
      </div>
      <AgentIdNote intent="sign-up" social={social} className="mt-4" />
      <AuthLegal className="mt-6" />
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
