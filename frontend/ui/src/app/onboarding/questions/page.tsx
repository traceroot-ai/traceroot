"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { QuestionsStep } from "@/features/onboarding/components/questions-step";
import { StandaloneFrame } from "@/features/onboarding/components/standalone-frame";
import { StepUnavailable } from "@/features/onboarding/components/step-unavailable";
import { connectStepUrl, createdInRun } from "@/features/onboarding/step-urls";
import { useSwitchAccount } from "@/features/onboarding/use-switch-account";
import { authClient } from "@/lib/auth-client";
import { safeCallbackUrl } from "@/lib/safe-callback-url";

/**
 * The sign-up questions, the first step after the workspace and project exist.
 * The project is in the address so a refresh stays on this step and creates
 * nothing again.
 *
 * Afterwards a sign-up from the browser goes on to connect GitHub and Slack. One
 * started in the terminal (`callbackUrl`, which `traceroot setup` is waiting on)
 * goes back there instead.
 */
export default function QuestionsStepPage() {
  return (
    <Suspense>
      <Questions />
    </Suspense>
  );
}

function Questions() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const created = createdInRun(searchParams);
  const callbackUrl = searchParams.get("callbackUrl");
  // Same-origin only, as on /onboarding: this is a value from the address.
  const returnTo = callbackUrl === null ? null : safeCallbackUrl(callbackUrl, "") || null;
  const { data: session } = authClient.useSession();
  // Back to /onboarding as the other account, which makes its own workspace and
  // project and asks it the questions; a waiting terminal's hand-back goes along.
  const switcher = useSwitchAccount(returnTo);

  if (!projectId) return <StepUnavailable />;

  return (
    <StandaloneFrame>
      <div className="w-full max-w-md">
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <Logo size="lg" />
          <div>
            <h1 className="text-[15px] font-medium">A few questions</h1>
            <p className="text-[13px] text-muted-foreground">
              So we can help you get more out of traceroot. Each one can be skipped.
            </p>
          </div>
        </div>
        {switcher.error && (
          <p
            role="alert"
            className="mb-4 border border-danger-border bg-danger-soft p-3 text-[12px] text-danger"
          >
            {switcher.error}
          </p>
        )}
        <Card>
          <CardContent className="p-4">
            <QuestionsStep
              onDone={() => router.push(returnTo ?? connectStepUrl(projectId, created))}
              userId={session?.user?.id}
              account={{
                email: session?.user?.email ?? null,
                switching: switcher.switching,
                onSwitch: (saved) => void switcher.switchAccount(saved),
              }}
            />
          </CardContent>
        </Card>
      </div>
    </StandaloneFrame>
  );
}
