"use client";

import { Suspense, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useHydrated } from "@/app/auth/use-hydrated";
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

// A workspace invitation returns to the recipient-checked accept route. A CLI
// signup first needs a workspace and project before its waiting terminal resumes.
function postSignUpDestination(callbackUrl: string): string {
  if (
    callbackUrl.startsWith("/invites/") &&
    z.string().uuid().safeParse(callbackUrl.slice("/invites/".length)).success
  ) {
    return callbackUrl;
  }
  // Match the /device path exactly, not by prefix: a startsWith check would also
  // catch an unrelated future route like /device-settings and wrongly funnel a
  // new account into the device-authorization flow.
  const [path, query = ""] = callbackUrl.split("?");
  if (path === "/device") {
    return `/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`;
  }
  // Back from "Not you? Sign out" on a sign-up step: /onboarding already carries
  // the terminal's hand-back, if there is one. Kept, or a terminal sign-up that
  // switches to a new account ends at the connect step, its terminal stranded.
  if (path === "/onboarding") {
    const handBack = new URLSearchParams(query).get("callbackUrl");
    const [handBackPath] = (handBack ?? "").split("?");
    if (handBack && handBackPath === "/device") {
      return `/onboarding?callbackUrl=${encodeURIComponent(handBack)}`;
    }
  }
  return "/onboarding";
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
  const hydrated = useHydrated();

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
            disabled={isLoading || !hydrated}
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
