"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useLayout } from "@/components/layout/app-layout";
import { createWorkspace, createProject } from "@/lib/api";
import { LayoutGrid, Layers, Check } from "lucide-react";

const onboardingSchema = z.object({
  workspaceName: z.string().min(1, "Workspace name is required"),
  projectName: z.string().min(1, "Project name is required"),
});

type OnboardingForm = z.infer<typeof onboardingSchema>;

function getDefaultWorkspaceName(email: string | null | undefined): string {
  if (!email) return "My Workspace";

  const domain = email.split("@")[1];
  if (!domain) return "My Workspace";

  const freeProviders = [
    "gmail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "protonmail.com",
    "mail.com",
  ];
  if (freeProviders.includes(domain.toLowerCase())) {
    return "My Workspace";
  }

  const company = domain.split(".")[0];
  return company.charAt(0).toUpperCase() + company.slice(1);
}

function OnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const { setHeaderContent } = useLayout();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Set header content
  useEffect(() => {
    setHeaderContent(<span className="text-[13px] font-medium">Workspaces</span>);
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  // Determine mode from query params
  const existingWorkspaceId = searchParams.get("workspaceId");
  const existingWorkspaceName = searchParams.get("workspaceName");
  const isProjectOnlyMode = !!existingWorkspaceId;

  const defaultWorkspace = getDefaultWorkspaceName(session?.user?.email);

  const {
    register,
    formState: { errors },
    getValues,
  } = useForm<OnboardingForm>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      workspaceName: defaultWorkspace,
      projectName: "my-llm-project",
    },
    values: {
      workspaceName: defaultWorkspace,
      projectName: "my-llm-project",
    },
  });

  async function handleSubmit() {
    setIsLoading(true);
    setError(null);

    try {
      let workspaceId = existingWorkspaceId;

      // Create workspace if not in project-only mode
      if (!isProjectOnlyMode) {
        const workspaceName = getValues("workspaceName");
        if (!workspaceName) {
          setError("Workspace name is required");
          setIsLoading(false);
          return;
        }
        const workspace = await createWorkspace(workspaceName);
        workspaceId = workspace.id;
      }

      if (!workspaceId) {
        setError("Workspace not found");
        setIsLoading(false);
        return;
      }

      // Create project
      const projectName = getValues("projectName");
      if (!projectName) {
        setError("Project name is required");
        setIsLoading(false);
        return;
      }

      const project = await createProject(workspaceId, projectName);

      queryClient.invalidateQueries({ queryKey: ["workspaces"] });

      router.push(`/projects/${project.id}/traces`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setIsLoading(false);
    }
  }

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    router.push("/auth/sign-in");
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-muted-foreground">Redirecting to sign in...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto max-w-md px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold">Setup</h1>
          <p className="text-[13px] text-muted-foreground">
            Set up your workspace and first project
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 p-3 text-[12px] text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Tree Form */}
        <Card>
          <CardContent className="p-4">
            <div className="space-y-0">
              {/* Workspace Section */}
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/10">
                    {isProjectOnlyMode ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <LayoutGrid className="h-4 w-4 text-primary" />
                    )}
                  </div>
                  {/* Vertical connector line */}
                  <div className="my-1.5 h-12 w-px bg-border" />
                </div>
                <div className="flex-1 pb-2 pt-0.5">
                  <label className="text-[13px] font-medium">Workspace</label>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Your team's home for billing and members
                  </p>
                  {isProjectOnlyMode ? (
                    <div className="flex max-w-xs items-center gap-2 border bg-muted/50 px-2.5 py-1.5 text-[13px]">
                      <span>{existingWorkspaceName || "Selected workspace"}</span>
                      <Check className="ml-auto h-3.5 w-3.5 text-green-600" />
                    </div>
                  ) : (
                    <Input
                      placeholder="Acme Inc"
                      {...register("workspaceName")}
                      className="h-8 max-w-xs text-[13px]"
                    />
                  )}
                  {errors.workspaceName && (
                    <p className="mt-1 text-[11px] text-red-500">{errors.workspaceName.message}</p>
                  )}
                </div>
              </div>

              {/* Project Section */}
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                <div className="flex-1 pb-2 pt-0.5">
                  <label className="text-[13px] font-medium">Project</label>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    Where your traces and experiments live
                  </p>
                  <Input
                    placeholder="my-llm-project"
                    {...register("projectName")}
                    className="h-8 max-w-xs text-[13px]"
                  />
                  {errors.projectName && (
                    <p className="mt-1 text-[11px] text-red-500">{errors.projectName.message}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center justify-center gap-2">
              <Button
                size="sm"
                className="h-7 px-4 text-[12px]"
                onClick={handleSubmit}
                disabled={isLoading}
              >
                {isLoading ? "Creating..." : "Create"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-4 text-[12px]"
                onClick={() => router.push("/workspaces")}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingContent />
    </Suspense>
  );
}
