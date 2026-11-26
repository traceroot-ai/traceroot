"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FirstTraceLine } from "@/components/first-trace-line";
import { StandaloneFrame } from "@/features/onboarding/components/standalone-frame";
import { StepUnavailable } from "@/features/onboarding/components/step-unavailable";
import { createdInRun } from "@/features/onboarding/step-urls";
import { useProjectTraceWait } from "@/features/onboarding/use-project-trace-wait";
import { SetupTabs, type SetupTab } from "@/features/traces/components/GettingStarted/SetupTabs";
import { useSetupSkipped } from "@/features/traces/components/GettingStarted/use-setup-command-copied";
import { getProject } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useOpenFoundTrace } from "@/lib/hooks/use-open-found-trace";
import { cn } from "@/lib/utils";

/**
 * The last sign-up step: the setup command, or setting up by hand, for the
 * project the run created — named in the address, so a refresh or a return from
 * the connect step lands back here.
 *
 * The page watches for the project's first trace across both tabs and opens it
 * when it lands; that line sits in the header, the one place that does not move
 * when the tab changes.
 */
export default function SetupStepPage() {
  return (
    <Suspense>
      <SetupStep />
    </Suspense>
  );
}

function SetupStep() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const created = createdInRun(searchParams);
  const { data: session } = authClient.useSession();
  const [tab, setTab] = useState<SetupTab>("ai");

  const { data: project, isError } = useQuery({
    queryKey: ["project", projectId, "onboarding-setup", session?.user.id],
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  });

  const traceWait = useProjectTraceWait(
    !!project,
    project?.id ?? null,
    session?.user?.id ? { id: session.user.id, email: session.user.email } : undefined,
    project?.read_at,
  );
  useOpenFoundTrace(traceWait);
  const recordSetupSkipped = useSetupSkipped(projectId, "onboarding");

  if (!projectId || isError) return <StepUnavailable />;

  const createdWhat = created === "project" ? "Project" : "Workspace and project";
  const manual = tab === "manual";

  return (
    <StandaloneFrame>
      {/* The manual walkthrough is numbered steps with code in them, so it gets a
          wider column than the command does. */}
      <div className={cn("w-full", manual ? "max-w-2xl" : "max-w-md")}>
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <Logo size="lg" />
          <div>
            <h1 className="text-[15px] font-medium">Let&apos;s get started</h1>
            <p className="text-[13px] text-muted-foreground">
              {/* "The rest happens in your terminal" stops being true the
                  moment the user says they would rather it did not. */}
              {manual
                ? `${createdWhat} created — add tracing to your application`
                : `${createdWhat} created — the rest happens in your terminal`}
            </p>
          </div>
          {/* Held open at two rows of the line's type whether or not there is
              anything in it yet, so the card below never steps down when the
              line appears or changes length. */}
          <div className="flex min-h-[33px] w-full items-start justify-center">
            {project ? <FirstTraceLine wait={traceWait} /> : null}
          </div>
        </div>

        <Card>
          <CardContent className="p-4">
            {project ? (
              <SetupTabs
                projectId={project.id}
                surface="onboarding"
                tab={tab}
                onTabChange={setTab}
                commandCopy={{
                  title: "Finish setting up in your terminal",
                  label: "terminal",
                  // Where to run it, because pasted in the wrong directory it
                  // writes the key where the application never reads it.
                  intro: `Run it where ${project.name}'s code lives. It asks before editing your code. Needs Node.js 20.12 or later.`,
                }}
                commandActions={
                  // Into the app with the application still uninstrumented: a
                  // workspace with a project in it is a finished account, so
                  // nothing routes this user back here.
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-4 text-[12px]"
                    onClick={() => {
                      recordSetupSkipped("command");
                      router.push("/workspaces");
                    }}
                  >
                    Skip for now
                  </Button>
                }
                manualFooter={
                  // The project's traces page, where the first trace of the run
                  // they are instrumenting will land, and which keeps these same
                  // tabs on screen until it does.
                  <div className="flex justify-center">
                    <Button
                      size="sm"
                      className="h-7 px-4 text-[12px]"
                      onClick={() => {
                        recordSetupSkipped("manual");
                        router.push(`/projects/${project.id}/traces`);
                      }}
                    >
                      Go to my project
                    </Button>
                  </div>
                }
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
