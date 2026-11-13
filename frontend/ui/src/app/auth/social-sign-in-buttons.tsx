"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/social-providers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

const AGENTID_MARK_PATHS = [
  "M318.029 88.3407C196.474 115.33 153.48 115.321 33.9244 88.3271C30.6216 87.5814 27.1432 88.9727 25.3284 91.8313L1.24109 129.774C-1.76483 134.509 0.965276 140.798 6.46483 141.898C152.613 171.13 197.678 171.182 343.903 141.835C349.304 140.751 352.064 134.641 349.247 129.907L326.719 92.0479C324.95 89.0744 321.407 87.5907 318.029 88.3407Z",
  "M75.9931 246.6L149.939 311.655C151.973 313.444 151.633 316.969 149.281 318.48L119.141 337.84C117.283 339.034 114.951 338.412 113.933 336.452L70.1276 252.036C68.0779 248.086 72.7553 243.751 75.9931 246.6Z",
  "M274.025 246.6L200.08 311.655C198.046 313.444 198.385 316.969 200.737 318.48L230.877 337.84C232.736 339.034 235.068 338.412 236.085 336.452L279.891 252.036C281.941 248.086 277.263 243.751 274.025 246.6Z",
  "M138.75 198.472L152.436 192.983C155.238 191.918 157.77 191.918 158.574 191.918C164.115 192.126 169.564 192.232 175.009 192.235C180.454 192.232 185.904 192.126 191.444 191.918C192.248 191.918 194.78 191.918 197.583 192.983L211.269 198.472C212.645 199.025 214.082 199.382 215.544 199.448C218.585 199.587 221.733 199.464 224.63 198.811C225.706 198.568 226.728 198.103 227.704 197.545L243.046 188.784C244.81 187.777 246.726 187.138 248.697 186.9L258.276 185.5H259.242H263.556L262.713 190.965L256.679 234.22C255.957 238.31 254.25 242.328 250.443 245.834L187.376 299.258C184.555 301.648 181.107 302.942 177.562 302.942H175.009H172.457C168.911 302.942 165.464 301.648 162.643 299.258L99.5761 245.834C95.7684 242.328 94.0614 238.31 93.3393 234.22L87.3059 190.965L86.4624 185.5H90.7771H91.7429L101.322 186.9C103.293 187.138 105.208 187.777 106.972 188.784L122.314 197.545C123.291 198.103 124.313 198.568 125.389 198.811C128.286 199.464 131.434 199.587 134.474 199.448C135.936 199.382 137.373 199.025 138.75 198.472Z",
  "M102.47 0.847827C205.434 44.796 156.456 42.1015 248.434 1.63153C252.885 -1.09955 258.353 1.88915 259.419 7.69219L269.235 61.1686L270.819 69.7893L263.592 71.8231L263.582 71.8259C190.588 92.3069 165.244 92.0078 86.7576 71.7428L79.1971 69.7905L80.9925 60.8681L91.8401 6.91975C92.9559 1.3706 98.105 -1.55777 102.47 0.847827Z",
];

// The official black and white marks: AgentID's brand rules forbid recolouring
// and sizes under 16px (17px keeps this 351x339 mark above that on both sides).
function AgentIdMark({ fill, className }: { fill: string; className: string }) {
  return (
    <svg
      viewBox="0 0 351 339"
      className={cn("h-[17px] w-[17px] shrink-0", className)}
      aria-hidden="true"
    >
      {AGENTID_MARK_PATHS.map((d) => (
        <path key={d} d={d} fill={fill} />
      ))}
    </svg>
  );
}

const PROVIDERS: Record<SocialProvider, { label: string; mark: React.ReactNode }> = {
  google: { label: "Google", mark: <GoogleMark /> },
  agentid: {
    label: "AgentID",
    mark: (
      <>
        <AgentIdMark fill="#18181B" className="dark:hidden" />
        <AgentIdMark fill="#FAFAFA" className="hidden dark:block" />
      </>
    ),
  },
};

const START_FAILED = "Could not start sign-in. Please try again.";

/** The "Or continue with" divider and one button per configured provider. */
export function SocialSignInButtons({
  providers,
  callbackURL,
  onError,
}: {
  providers: SocialProvider[];
  callbackURL: string;
  onError: (message: string | null) => void;
}) {
  const [redirectingTo, setRedirectingTo] = useState<SocialProvider | null>(null);
  if (providers.length === 0) return null;

  async function signIn(provider: SocialProvider) {
    setRedirectingTo(provider);
    onError(null);
    // On success the browser leaves the page; on failure both buttons come back.
    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (!result?.error) return;
      onError(result.error.message || START_FAILED);
    } catch {
      onError(START_FAILED);
    }
    setRedirectingTo(null);
  }

  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-[12px] uppercase">
          <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
        </div>
      </div>

      <div className={cn("grid gap-2", providers.length > 1 && "grid-cols-2")}>
        {providers.map((provider) => (
          <Button
            key={provider}
            variant="outline"
            size="sm"
            className="h-8 w-full gap-2 text-[13px]"
            onClick={() => signIn(provider)}
            disabled={redirectingTo !== null}
          >
            {redirectingTo === provider ? (
              "Redirecting..."
            ) : (
              <>
                {PROVIDERS[provider].mark}
                {PROVIDERS[provider].label}
              </>
            )}
          </Button>
        ))}
      </div>
    </>
  );
}
