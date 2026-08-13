"use client";

import { Suspense, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { safeCallbackUrl } from "@/lib/safe-callback-url";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/Logo";

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

type SignUpForm = z.infer<typeof signUpSchema>;

type SignUpClientProps = {
  googleAuthConfigured: boolean;
};

// A brand-new account always finishes at onboarding. The one thing that can
// need to happen first is a pending device authorization — the CLI login flow
// sends the user through /device before they sign up — so route through it,
// telling it (via ?next) to continue to onboarding once approved. Anything else
// goes straight to onboarding; a new user shouldn't be dropped deep in the app.
function postSignUpDestination(callbackUrl: string): string {
  if (!callbackUrl.startsWith("/device")) {
    return "/onboarding";
  }
  const params = new URLSearchParams(callbackUrl.split("?")[1] ?? "");
  params.set("next", "/onboarding");
  return `/device?${params.toString()}`;
}

function SignUpContent({ googleAuthConfigured }: SignUpClientProps) {
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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignUpForm>({
    resolver: zodResolver(signUpSchema),
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
    <div className="flex h-full min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mb-2 flex justify-center">
            <Logo size="lg" />
          </div>
          <CardTitle className="text-lg font-semibold">Create your account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <div className="border border-red-200 bg-red-50 p-3 text-[12px] text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label className="mb-1 block text-[13px] font-medium">Name</label>
              <Input placeholder="John Doe" className="h-8 text-[13px]" {...register("name")} />
              {errors.name && (
                <p className="mt-1 text-[11px] text-red-500">{errors.name.message}</p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium">Email</label>
              <Input
                type="email"
                placeholder="you@example.com"
                className="h-8 text-[13px]"
                {...register("email")}
              />
              {errors.email && (
                <p className="mt-1 text-[11px] text-red-500">{errors.email.message}</p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium">Password</label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="********"
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
                <p className="mt-1 text-[11px] text-red-500">{errors.password.message}</p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-[13px] font-medium">Confirm Password</label>
              <div className="relative">
                <Input
                  type={showConfirmPassword ? "text" : "password"}
                  placeholder="********"
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
                <p className="mt-1 text-[11px] text-red-500">{errors.confirmPassword.message}</p>
              )}
            </div>

            <Button type="submit" size="sm" className="h-8 w-full text-[13px]" disabled={isLoading}>
              {isLoading ? "Creating account..." : "Sign up"}
            </Button>
          </form>

          {googleAuthConfigured && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-[11px] uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
                </div>
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-8 w-full text-[13px]"
                onClick={handleGoogleSignUp}
                disabled={isGoogleLoading}
              >
                {isGoogleLoading ? "Redirecting..." : "Google"}
              </Button>
            </>
          )}

          <p className="text-center text-[12px] text-muted-foreground">
            Already have an account?{" "}
            <Link href={signInHref} className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function SignUpClient({ googleAuthConfigured }: SignUpClientProps) {
  return (
    <Suspense>
      <SignUpContent googleAuthConfigured={googleAuthConfigured} />
    </Suspense>
  );
}
