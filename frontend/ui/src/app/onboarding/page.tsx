"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v3";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLayout } from "@/components/layout/app-layout";
import { Logo } from "@/components/Logo";
import { createWorkspace, createProject } from "@/lib/api";
import { AlertCircle, Check, Layers, LayoutGrid } from "lucide-react";

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
  const { data: session, isPending } = authClient.useSession();
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

  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session && !isPending) {
    router.push("/auth/sign-in");
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[13px] text-muted-foreground">Redirecting to sign in...</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto grid min-h-full max-w-xl place-items-center px-4 py-12">
        <div className="w-full">
          {/* Welcome header */}
          <div className="mb-8 flex items-center gap-4">
            <Logo size="md" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Welcome to TraceRoot</h1>
              <p className="text-sm text-muted-foreground">
                Set up your workspace and first project to start capturing traces.
              </p>
            </div>
          </div>

          {/* Error callout */}
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/50">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              <span className="text-red-700 dark:text-red-300">{error}</span>
            </div>
          )}

          {/* Step cards */}
          <div className="space-y-3">
            {/* Workspace step */}
            <div className="rounded-xl border border-gray-950/10 bg-card p-5 transition-colors hover:border-primary dark:border-white/10">
              <div className="flex items-start gap-4">
                <div
                  className={
                    isProjectOnlyMode
                      ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
                      : "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"
                  }
                >
                  {isProjectOnlyMode ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <LayoutGrid className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium">Workspace</label>
                  <p className="mb-3 text-sm text-muted-foreground">
                    Your team's home for billing and members
                  </p>
                  {isProjectOnlyMode ? (
                    <div className="inline-flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm dark:border-green-900 dark:bg-green-950/50">
                      <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                      <span className="font-medium">
                        {existingWorkspaceName || "Selected workspace"}
                      </span>
                    </div>
                  ) : (
                    <Input placeholder="Acme Inc" {...register("workspaceName")} />
                  )}
                  {errors.workspaceName && (
                    <p className="mt-2 text-xs text-destructive">{errors.workspaceName.message}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Project step */}
            <div className="rounded-xl border border-gray-950/10 bg-card p-5 transition-colors hover:border-primary dark:border-white/10">
              <div className="flex items-start gap-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <Layers className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium">Project</label>
                  <p className="mb-3 text-sm text-muted-foreground">
                    Where your traces and experiments live
                  </p>
                  <Input placeholder="my-llm-project" {...register("projectName")} />
                  {errors.projectName && (
                    <p className="mt-2 text-xs text-destructive">{errors.projectName.message}</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="mt-6 flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => router.push("/workspaces")}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
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
