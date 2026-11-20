"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "@/components/Logo";
import { Card, CardContent } from "@/components/ui/card";
import { ConnectStep } from "@/features/onboarding/components/connect-step";
import { StandaloneFrame } from "@/features/onboarding/components/standalone-frame";
import { StepUnavailable } from "@/features/onboarding/components/step-unavailable";
import { connectStepUrl, createdInRun, setupStepUrl } from "@/features/onboarding/step-urls";
import { getProject } from "@/lib/api";

/**
 * The sign-up step that connects GitHub and Slack, between creating the
 * workspace and project and the setup command. The project is in the address
 * because both authorizations leave the site and come back here, and Slack's
 * outcome comes back on it too (`slack=connected`, or `slack=error&reason=…`).
 *
 * A sign-up started from the terminal never reaches this step: after the
 * questions it goes back to the terminal.
 */
export default function ConnectStepPage() {
  return (
    <Suspense>
      <Connect />
    </Suspense>
  );
}

function Connect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const created = createdInRun(searchParams);

  const { data: project, isError } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  });

  if (!projectId || isError) return <StepUnavailable />;
  const next = () => router.push(setupStepUrl(projectId, created));

  return (
    <StandaloneFrame>
      <div className="w-full max-w-md">
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <Logo size="lg" />
          <div>
            <h1 className="text-[15px] font-medium">Connect GitHub and Slack</h1>
            <p className="text-[13px] text-muted-foreground">
              GitHub links a problem to the code behind it. Slack posts alerts to your team&apos;s
              channel. To connect later, go to{" "}
              <span className="text-foreground">Workspace settings → Integrations</span>.
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="p-4">
            {project ? (
              <ConnectStep
                workspaceId={project.workspace_id}
                // Back to this same step, with its project, from either site.
                returnTo={connectStepUrl(projectId, created)}
                slackOutcome={{
                  result: searchParams.get("slack"),
                  reason: searchParams.get("reason"),
                }}
                githubOutcome={searchParams.get("github")}
                onContinue={next}
                onSkip={next}
              />
            ) : (
              <p className="py-6 text-center text-[12px] text-muted-foreground">Loading…</p>
            )}
          </CardContent>
        </Card>
      </div>
    </StandaloneFrame>
  );
}
