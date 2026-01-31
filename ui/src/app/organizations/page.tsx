"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, getOrganization } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { useLayout } from "@/components/layout/app-layout";
import { Plus, FolderKanban, ChevronRight, Building2 } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export default function OrganizationsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <span className="text-sm font-medium">Organizations</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  // Get all organizations
  const { data: organizations, isLoading: orgsLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: status === "authenticated",
  });

  // Get details (with projects) for each org
  const { data: orgsWithProjects, isLoading: projectsLoading } = useQuery({
    queryKey: ["organizations-with-projects", organizations?.map(o => o.id)],
    queryFn: async () => {
      if (!organizations) return [];
      const results = await Promise.all(
        organizations.map(org => getOrganization(org.id))
      );
      return results;
    },
    enabled: !!organizations && organizations.length > 0,
  });

  // Auto-select first org
  useEffect(() => {
    if (orgsWithProjects && orgsWithProjects.length > 0 && !selectedOrgId) {
      setSelectedOrgId(orgsWithProjects[0].id);
    }
  }, [orgsWithProjects, selectedOrgId]);

  if (!user) {
    return null;
  }

  const isLoading = orgsLoading || projectsLoading;
  const selectedOrg = orgsWithProjects?.find(org => org.id === selectedOrgId);

  return (
    <div className="h-full bg-background">
      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-muted-foreground">Loading organizations...</p>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && (!orgsWithProjects || orgsWithProjects.length === 0) && (
        <div className="flex items-center justify-center py-16">
          <Card className="border-dashed max-w-md">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <Building2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1">No organizations yet</h3>
              <p className="text-sm text-muted-foreground mb-4 text-center">
                Create your first organization to get started
              </p>
              <Link href="/onboarding">
                <div className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Organization
                </div>
              </Link>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Two-panel layout */}
      {!isLoading && orgsWithProjects && orgsWithProjects.length > 0 && (
        <div className="flex h-full">
          {/* Left Panel - Org List */}
          <div className="w-48 border-r flex flex-col">
            <div className="flex-1">
              {orgsWithProjects.map((org) => (
                <button
                  key={org.id}
                  onClick={() => setSelectedOrgId(org.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                    selectedOrgId === org.id
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  <div className="flex h-7 w-7 items-center justify-center bg-muted text-xs font-medium shrink-0">
                    {org.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm">{org.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {org.projects.length} project{org.projects.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                </button>
              ))}

              {/* Add Organization */}
              <Link href="/onboarding" className="block">
                <div className="w-full flex items-center justify-center px-3 py-4 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors cursor-pointer">
                  <Plus className="h-5 w-5" />
                </div>
              </Link>
            </div>
          </div>

          {/* Right Panel - Projects */}
          {selectedOrg && (
            <div className="flex-1 p-6 overflow-auto">
              {/* Projects Grid */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {selectedOrg.projects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/${project.id}/traces`}
                    className="group"
                  >
                    <Card className="rounded-sm transition-all hover:shadow-md hover:border-foreground/20">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center bg-muted">
                            <FolderKanban className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium truncate">
                              {project.name}
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              Created {new Date(project.created_at).toLocaleDateString()}
                            </p>
                          </div>
                          <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}

                {/* Add Project Card */}
                <Link
                  href={`/onboarding?orgId=${selectedOrg.id}&orgName=${encodeURIComponent(selectedOrg.name)}`}
                  className="group"
                >
                  <Card className="rounded-sm border-dashed h-full transition-all hover:border-foreground/30 hover:bg-muted/50 cursor-pointer">
                    <CardContent className="p-4 h-full flex items-center justify-center min-h-[76px]">
                      <Plus className="h-6 w-6 text-muted-foreground group-hover:text-foreground transition-colors" />
                    </CardContent>
                  </Card>
                </Link>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
