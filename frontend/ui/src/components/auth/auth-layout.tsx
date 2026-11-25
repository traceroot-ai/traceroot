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
import { Button } from "@/components/ui/button";
import { Input, type InputProps } from "@/components/ui/input";
import { PixelField, PixelWordmark, YCBadge } from "@/components/brand/pixel-art";
import { cn } from "@/lib/utils";
import type { SocialSignIn } from "@/app/auth/use-social-sign-in";

/**
 * Sign-in and sign-up shell: the brand panel beside the form, stacked on small screens.
 * `topAction` sits in the page's top-right corner, level with the logo, on every width.
 */
export function AuthLayout({
  children,
  topAction,
}: {
  children: ReactNode;
  topAction?: ReactNode;
}) {
  return (
    <div className="relative grid min-h-screen grid-rows-[auto_1fr] bg-background lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,1fr)] lg:grid-rows-1">
      {topAction && (
        <div className="absolute right-5 top-[14px] z-10 flex items-center gap-3 lg:right-10 lg:top-[34px]">
          {topAction}
        </div>
      )}
      <AuthBrandPanel />
      <main className="flex justify-center px-5 py-7 lg:items-center lg:p-8 lg:pb-[34px]">
        <div className="w-full max-w-[360px]">{children}</div>
      </main>
    </div>
  );
}

const LOOP = ["trace", "detect", "signals", "verify"];

/** Left side of the auth pages: the website's pixel art, tagline and improvement loop. */
export function AuthBrandPanel() {
  return (
    <section className="relative flex min-h-[264px] flex-col justify-between overflow-hidden border-b border-border px-5 py-5 lg:min-h-screen lg:justify-start lg:border-b-0 lg:border-r lg:px-10 lg:py-10">
      <PixelField />

      {/* The pixel wordmark below names the product to screen readers; this
          small logo would only say it a second time. */}
      <div className="relative flex items-center" aria-hidden="true">
        <Logo size="sm" />
      </div>

      <div className="relative mt-[100px] max-w-[560px] lg:mt-auto">
        <PixelWordmark className="lg:max-w-[538px]" />
        <p className="mt-5 hidden max-w-[560px] text-[17px] leading-[26px] text-muted-foreground lg:-ml-px lg:block">
          The open-source platform that{" "}
          <span className="font-medium text-foreground">continuously improves</span> your AI agents.
        </p>
        <LoopDiagram className="mt-[30px] hidden lg:-ml-[0.5px] lg:block" />
      </div>

      <div className="relative hidden lg:mt-[clamp(40px,15vh,132px)] lg:flex">
        <YCBadge />
      </div>
    </section>
  );
}

// Where each step's label starts and how wide it is, in the diagram's 13px mono.
const LOOP_STEPS = [
  { x: 0, w: 39 },
  { x: 85, w: 46.8 },
  { x: 177.8, w: 54.6 },
  { x: 278.4, w: 46.8 },
];

/**
 * The improvement loop: the four steps in a row, with the line from the last one
 * running back under them to the first, through "your agent in production".
 */
function LoopDiagram({ className }: { className?: string }) {
  return (
    <div className={className}>
      <ol aria-label="The improvement loop" className="sr-only">
        {LOOP.map((step) => (
          <li key={step}>{step}</li>
        ))}
        <li>back to your agent in production</li>
      </ol>
      <svg
        viewBox="0 0 360 50"
        className="h-[50px] w-[360px] overflow-visible font-mono"
        aria-hidden="true"
      >
        <path
          d="M49 10.25H70M142 10.25H163M242 10.25H263M335 10.25H352.25Q357.25 10.25 357.25 15.25V35.25Q357.25 40.25 352.25 40.25H290M92 40.25H25.25Q20.25 40.25 20.25 35.25V28"
          fill="none"
          className="stroke-primary"
          strokeWidth="1.5"
        />
        <path
          d="M75 10.25l-6 -3v6zM168 10.25l-6 -3v6zM268 10.25l-6 -3v6zM285 40.25l6 -3v6zM20.25 23l-3 6h6z"
          className="fill-primary"
        />
        {LOOP.map((step, i) => (
          <text
            key={step}
            x={LOOP_STEPS[i]!.x}
            y="14"
            textLength={LOOP_STEPS[i]!.w}
            lengthAdjust="spacingAndGlyphs"
            className="fill-foreground text-[13px] font-semibold"
          >
            {step}
          </text>
        ))}
        <text
          x="102"
          y="44"
          textLength="172.8"
          lengthAdjust="spacingAndGlyphs"
          className="fill-primary text-[12px]"
        >
          your agent in production
        </text>
      </svg>
    </div>
  );
}

export function AuthHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-[31px]">
      <h1 className="text-[24px] font-[600] leading-7 tracking-[-0.02em]">{title}</h1>
      <p className="mt-1.5 text-[14px] text-muted-foreground">{subtitle}</p>
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
        <label htmlFor={id} className="block text-[13px] font-medium leading-5">
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

/**
 * One "Continue with …" button. A provider whose sign-in flow isn't available yet
 * passes no `onClick`: the button still shows, disabled, so it never starts a flow
 * that can't finish.
 */
export function AuthProviderButton({
  icon,
  label,
  onClick,
  isLoading = false,
  disabled = false,
  unavailableReason,
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  isLoading?: boolean;
  /** Disabled for now, for instance while another sign-in is redirecting. */
  disabled?: boolean;
  /** Said on hover and to screen readers while the button is disabled for lack of a flow. */
  unavailableReason?: string;
  /** Merged into the button's classes. */
  className?: string;
}) {
  const reasonId = useId();
  const unavailable = !onClick && unavailableReason;
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("h-8 w-full gap-2 text-[13px]", className)}
      onClick={onClick}
      disabled={!onClick || isLoading || disabled}
      aria-describedby={unavailable ? reasonId : undefined}
    >
      {icon}
      {isLoading ? "Redirecting..." : label}
    </Button>
  );
  if (!unavailable) return button;
  return (
    <UnavailableReason id={reasonId} reason={unavailableReason} className="block">
      {button}
    </UnavailableReason>
  );
}

/**
 * Wraps a disabled control so its reason still reaches people: the wrapper takes the
 * hover tooltip (a disabled control gets no pointer events or focus), and a hidden
 * description that the control points at with aria-describedby is read aloud.
 */
function UnavailableReason({
  id,
  reason,
  className,
  children,
}: {
  id: string;
  reason: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span title={reason} className={cn("cursor-not-allowed", className)}>
      {children}
      <span id={id} className="sr-only">
        {reason}
      </span>
    </span>
  );
}

/** The "or" rule between the provider buttons and the email form. */
export function AuthDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "my-5 flex items-center gap-2.5 font-mono text-[11px] uppercase leading-none tracking-[0.04em] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
        className,
      )}
    >
      or
    </div>
  );
}

/**
 * The provider buttons above the email form, then the "or" divider. Sign-in and
 * sign-up both render this from the same `social`, so an option is available on
 * both pages or on neither. GitHub has no sign-in provider yet and stays disabled;
 * Google shows when its client is configured.
 */
export function AuthProviderOptions({ social }: { social: SocialSignIn }) {
  const button = "h-10 gap-[10px] text-[14px]";
  return (
    <>
      <div className="space-y-2">
        <AuthProviderButton
          icon={<GitHubLogo />}
          label="Continue with GitHub"
          unavailableReason="GitHub sign-in isn't available yet"
          className={button}
        />
        {social.providers.includes("google") && (
          <AuthProviderButton
            icon={<GoogleLogo />}
            label="Continue with Google"
            onClick={() => social.signIn("google")}
            isLoading={social.redirectingTo === "google"}
            disabled={social.redirectingTo !== null}
            className={button}
          />
        )}
      </div>
      <AuthDivider className="my-[26.5px]" />
    </>
  );
}

const AGENTID_PROMPT = {
  "sign-up": "Signing up an AI agent?",
  "sign-in": "Signing in as an AI agent?",
};

/**
 * "Signing up an AI agent? Continue with AgentID" under the sign-up button, and its
 * sign-in wording under the sign-in button. The action works when AgentID is among
 * `social.providers`; otherwise it shows disabled, with the reason, on both pages.
 */
export function AgentIdNote({
  intent,
  social,
  className,
}: {
  intent: keyof typeof AGENTID_PROMPT;
  social: SocialSignIn;
  className?: string;
}) {
  const reasonId = useId();
  const onClick = social.providers.includes("agentid") ? () => social.signIn("agentid") : undefined;
  const agentIdAction = (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || social.redirectingTo !== null}
      aria-describedby={onClick ? undefined : reasonId}
      className="font-[600] text-[#097c78] hover:underline disabled:pointer-events-none disabled:opacity-50 dark:text-primary"
    >
      {social.redirectingTo === "agentid" ? "Redirecting..." : "Continue with AgentID"}
    </button>
  );
  return (
    <div
      className={cn(
        "flex min-h-10 items-center justify-center gap-[10px] rounded-[2px] border border-border bg-[#f7fafa] px-3 py-2 text-[13px] leading-4 text-[#35393b] dark:bg-muted dark:text-muted-foreground",
        className,
      )}
    >
      {/* AgentID's brand rules allow only its black mark, white in dark mode, 16px or larger. */}
      <AgentIdLogo className="h-[17.5px] w-[18px] shrink-0 text-[#18181B] dark:text-[#FAFAFA]" />
      <span>
        {AGENTID_PROMPT[intent]}{" "}
        {onClick ? (
          agentIdAction
        ) : (
          <UnavailableReason id={reasonId} reason={AGENTID_UNAVAILABLE}>
            {agentIdAction}
          </UnavailableReason>
        )}
      </span>
    </div>
  );
}

const AGENTID_UNAVAILABLE = "AgentID sign-in isn't available yet";

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
      {showLegal && <AuthLegal className="mt-8" />}
    </>
  );
}

/** The Terms and Privacy Policy line under an auth form. */
export function AuthLegal({ className }: { className?: string }) {
  return (
    <p className={cn("text-center text-[11px] leading-4 text-muted-foreground", className)}>
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
          className="absolute right-[14px] top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
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

/** GitHub's mark, in the current text colour. */
export function GitHubLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className ?? "h-4 w-4"}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** AgentID's mark, in the current text colour. */
function AgentIdLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 351 340" className={className} fill="currentColor" aria-hidden="true">
      <path d="M318.029 88.3407C196.474 115.33 153.48 115.321 33.9244 88.3271C30.6216 87.5814 27.1432 88.9727 25.3284 91.8313L1.24109 129.774C-1.76483 134.509 0.965276 140.798 6.46483 141.898C152.613 171.13 197.678 171.182 343.903 141.835C349.304 140.751 352.064 134.641 349.247 129.907L326.719 92.0479C324.95 89.0744 321.407 87.5907 318.029 88.3407Z" />
      <path d="M75.9931 246.6L149.939 311.655C151.973 313.444 151.633 316.969 149.281 318.48L119.141 337.84C117.283 339.034 114.951 338.412 113.933 336.452L70.1276 252.036C68.0779 248.086 72.7553 243.751 75.9931 246.6Z" />
      <path d="M274.025 246.6L200.08 311.655C198.046 313.444 198.385 316.969 200.737 318.48L230.877 337.84C232.736 339.034 235.068 338.412 236.085 336.452L279.891 252.036C281.941 248.086 277.263 243.751 274.025 246.6Z" />
      <path d="M138.75 198.472L152.436 192.983C155.238 191.918 157.77 191.918 158.574 191.918C164.115 192.126 169.564 192.232 175.009 192.235C180.454 192.232 185.904 192.126 191.444 191.918C192.248 191.918 194.78 191.918 197.583 192.983L211.269 198.472C212.645 199.025 214.082 199.382 215.544 199.448C218.585 199.587 221.733 199.464 224.63 198.811C225.706 198.568 226.728 198.103 227.704 197.545L243.046 188.784C244.81 187.777 246.726 187.138 248.697 186.9L258.276 185.5H259.242H263.556L262.713 190.965L256.679 234.22C255.957 238.31 254.25 242.328 250.443 245.834L187.376 299.258C184.555 301.648 181.107 302.942 177.562 302.942H175.009H172.457C168.911 302.942 165.464 301.648 162.643 299.258L99.5761 245.834C95.7684 242.328 94.0614 238.31 93.3393 234.22L87.3059 190.965L86.4624 185.5H90.7771H91.7429L101.322 186.9C103.293 187.138 105.208 187.777 106.972 188.784L122.314 197.545C123.291 198.103 124.313 198.568 125.389 198.811C128.286 199.464 131.434 199.587 134.474 199.448C135.936 199.382 137.373 199.025 138.75 198.472Z" />
      <path d="M102.47 0.847827C205.434 44.796 156.456 42.1015 248.434 1.63153C252.885 -1.09955 258.353 1.88915 259.419 7.69219L269.235 61.1686L270.819 69.7893L263.592 71.8231L263.582 71.8259C190.588 92.3069 165.244 92.0078 86.7576 71.7428L79.1971 69.7905L80.9925 60.8681L91.8401 6.91975C92.9559 1.3706 98.105 -1.55777 102.47 0.847827Z" />
    </svg>
  );
}
