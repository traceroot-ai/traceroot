"use client";

import {
  cloneElement,
  forwardRef,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Eye, EyeOff } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, type InputProps } from "@/components/ui/input";
import { PixelField, PixelWordmark, YCBadge } from "@/components/brand/pixel-art";
import { cn } from "@/lib/utils";

/** Sign-in and sign-up shell: the brand panel beside the form, stacked on small screens. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,1fr)]">
      <AuthBrandPanel />
      <main className="flex justify-center px-5 py-7 lg:items-center lg:p-8">
        <div className="w-full max-w-[360px]">{children}</div>
      </main>
    </div>
  );
}

const LOOP = ["trace", "detect", "evaluate", "improve"];

const MONO_BADGE = "rounded-[2px] font-mono text-[11px] font-normal";

/** Left side of the auth pages: the website's pixel art, tagline and improvement loop. */
export function AuthBrandPanel() {
  return (
    <section className="relative flex flex-col justify-between overflow-hidden border-b border-border bg-[radial-gradient(900px_520px_at_78%_12%,hsl(var(--brand-soft)),transparent_70%)] px-5 py-5 lg:min-h-screen lg:border-b-0 lg:border-r lg:px-10 lg:py-8">
      <PixelField />

      <div className="relative flex items-center justify-between">
        <Logo size="sm" />
        <Badge variant="accent" className={`${MONO_BADGE} px-2 py-1.5`}>
          open source · YC
        </Badge>
      </div>

      <div className="relative mt-[100px] max-w-[560px] lg:mt-[30vh]">
        <PixelWordmark className="-ml-1.5 lg:max-w-[520px]" />
        <p className="mt-[18px] hidden max-w-[440px] text-[17px] leading-[26px] text-muted-foreground lg:block">
          The open-source platform that{" "}
          <span className="font-medium text-foreground">continuously improves</span> your AI agents.
        </p>
        <ol
          aria-label="The improvement loop"
          className="mt-[22px] hidden flex-wrap items-center gap-2 lg:flex"
        >
          {LOOP.map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              {i > 0 && <span className="font-mono text-[11px] text-muted-foreground">-&gt;</span>}
              <Badge
                variant="outline"
                className={`${MONO_BADGE} gap-1.5 bg-background px-[9px] py-[7px] text-foreground`}
              >
                <i className="h-1.5 w-1.5 bg-primary" aria-hidden="true" />
                {step}
              </Badge>
            </li>
          ))}
        </ol>
      </div>

      <div className="relative mt-10 hidden lg:flex">
        <YCBadge />
      </div>
    </section>
  );
}

export function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-7">
      <h1 className="text-[22px] font-medium leading-7 tracking-[-0.01em]">{title}</h1>
      <p className="mt-1.5 text-[13px] text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/** Label, control and validation message for one auth form field. */
export function AuthField({
  label,
  error,
  action,
  children,
}: {
  label: string;
  error?: string;
  /** Shown at the right of the label, e.g. a "Forgot?" link. */
  action?: ReactNode;
  /** The field's single input, which receives the label's id. */
  children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id} className="block text-[13px] font-medium">
          {label}
        </label>
        {action}
      </div>
      {cloneElement(children, { id })}
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

export function AuthError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border border-danger-border bg-danger-soft p-3 text-[12px] text-danger"
    >
      {message}
    </div>
  );
}

/** "Continue with Google" followed by the "or" divider that leads into the email form. */
export function GoogleAuthOption({
  onClick,
  isLoading,
}: {
  onClick: () => void;
  isLoading: boolean;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 w-full gap-2 text-[13px]"
        onClick={onClick}
        disabled={isLoading}
      >
        <GoogleLogo />
        {isLoading ? "Redirecting..." : "Continue with Google"}
      </Button>
      <div className="my-5 flex items-center gap-2.5 font-mono text-[11px] uppercase leading-none tracking-[0.04em] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
        or
      </div>
    </>
  );
}

export function AuthFooter({
  children,
  showLegal = true,
}: {
  children: ReactNode;
  showLegal?: boolean;
}) {
  return (
    <>
      <p className="mt-6 text-center text-[12px] text-muted-foreground">{children}</p>
      {showLegal && (
        <p className="mt-8 text-center text-[11px] leading-4 text-muted-foreground">
          By continuing you agree to the{" "}
          <a href="https://traceroot.ai/terms" className="underline hover:text-foreground">
            Terms
          </a>{" "}
          and{" "}
          <a href="https://traceroot.ai/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </a>
          .
        </p>
      )}
    </>
  );
}

/** Password field with a show/hide toggle. Forwards its ref, so it works with react-hook-form's register. */
const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, "type">>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };

/** Google's four-colour "G", for "Continue with Google" buttons. */
export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className ?? "h-4 w-4"} aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
