"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useLayout } from "@/components/layout/app-layout";
import { createOrganization, createProject, createApiKey } from "@/lib/api";
import { LayoutGrid, Layers, Check } from "lucide-react";

const onboardingSchema = z.object({
  workspaceName: z.string().min(1, "Organization name is required"),
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

export default function OnboardingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session, status } = useSession();
  const { setHeaderContent } = useLayout();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <span className="text-[13px] font-medium">Organizations</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  // Determine mode from query params
  const existingOrgId = searchParams.get("orgId");
  const existingOrgName = searchParams.get("orgName");
  const isProjectOnlyMode = !!existingOrgId;

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
      let orgId = existingOrgId;

      // Create org if not in project-only mode
      if (!isProjectOnlyMode) {
        const workspaceName = getValues("workspaceName");
        if (!workspaceName) {
          setError("Organization name is required");
          setIsLoading(false);
          return;
        }
        const org = await createOrganization(workspaceName);
        orgId = org.id;
      }

      if (!orgId) {
        setError("Organization not found");
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

      const project = await createProject(orgId, projectName);
      const apiKeyResponse = await createApiKey(project.id, "default");

      if (typeof window !== "undefined") {
        sessionStorage.setItem("onboarding_api_key", apiKeyResponse.data.key);
      }

      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["organizations-with-projects"] });

      router.push(`/${project.id}/traces`);
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
    <div className="h-full bg-background overflow-auto">
      <div className="mx-auto max-w-md px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg font-semibold">Setup</h1>
          <p className="text-[13px] text-muted-foreground">
            Set up your organization and first project
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
              {/* Organization Section */}
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-primary/10 rounded">
                    {isProjectOnlyMode ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <LayoutGrid className="h-4 w-4 text-primary" />
                    )}
                  </div>
                  {/* Vertical connector line */}
                  <div className="w-px h-12 bg-border my-1.5" />
                </div>
                <div className="flex-1 pt-0.5 pb-2">
                  <label className="text-[13px] font-medium">Organization</label>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    Your team's home for billing and members
                  </p>
                  {isProjectOnlyMode ? (
                    <div className="flex items-center gap-2 border bg-muted/50 px-2.5 py-1.5 max-w-xs text-[13px]">
                      <span>{existingOrgName || "Selected organization"}</span>
                      <Check className="h-3.5 w-3.5 text-green-600 ml-auto" />
                    </div>
                  ) : (
                    <Input
                      placeholder="Acme Inc"
                      {...register("workspaceName")}
                      className="max-w-xs h-8 text-[13px]"
                    />
                  )}
                  {errors.workspaceName && (
                    <p className="mt-1 text-[11px] text-red-500">
                      {errors.workspaceName.message}
                    </p>
                  )}
                </div>
              </div>

              {/* Project Section */}
              <div className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted rounded">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                <div className="flex-1 pt-0.5 pb-2">
                  <label className="text-[13px] font-medium">Project</label>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    Where your traces and experiments live
                  </p>
                  <Input
                    placeholder="my-llm-project"
                    {...register("projectName")}
                    className="max-w-xs h-8 text-[13px]"
                  />
                  {errors.projectName && (
                    <p className="mt-1 text-[11px] text-red-500">
                      {errors.projectName.message}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center justify-center gap-2">
              <Button size="sm" className="h-7 text-[12px] px-4" onClick={handleSubmit} disabled={isLoading}>
                {isLoading ? "Creating..." : "Create"}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-[12px] px-4" onClick={() => router.push("/organizations")}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
