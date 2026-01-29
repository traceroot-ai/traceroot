"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getOrganization,
  getMembers,
  deleteProject,
  removeMember,
  type Role,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { useLayout } from "@/components/layout/app-layout";
import { Settings, Trash2, Users, ChevronRight } from "lucide-react";
import Link from "next/link";

const roleColors: Record<string, string> = {
  OWNER: "bg-primary text-primary-foreground",
  ADMIN: "bg-gray-700 text-white",
  MEMBER: "bg-gray-200 text-gray-800",
  VIEWER: "bg-gray-100 text-gray-600",
};

function canManageMembers(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function canDeleteProject(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export default function OrganizationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const orgId = params.orgId as string;
  const { data: session } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  const {
    data: org,
    isLoading: orgLoading,
    error: orgError,
  } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: !!user && !!orgId,
  });

  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => getMembers(orgId),
    enabled: !!user && !!orgId && !!org && canManageMembers(org.role),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (projectId: string) => deleteProject(orgId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
    },
  });

  // Set header content with org name
  useEffect(() => {
    if (org) {
      setHeaderContent(
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/organizations"
            className="text-muted-foreground hover:text-foreground"
          >
            Organizations
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium">{org.name}</span>
        </div>
      );
    }
    return () => setHeaderContent(null);
  }, [org, setHeaderContent]);

  if (!user) {
    return null;
  }

  if (orgLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading organization...</p>
      </div>
    );
  }

  if (orgError || !org) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">
            {orgError?.message || "Organization not found"}
          </p>
          <Link href="/organizations">
            <Button variant="outline" className="mt-4">
              Back to Organizations
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-4xl px-6 py-6">
        {/* Page Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{org.name}</h1>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Settings className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Users className="h-4 w-4" />
            </Button>
            <CreateProjectDialog orgId={orgId} />
          </div>
        </div>

        {/* Projects Section */}
        {org.projects.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="mb-4 text-sm text-muted-foreground">
                No projects yet. Create your first project to get started.
              </p>
              <CreateProjectDialog orgId={orgId} />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {org.projects.map((project) => (
              <Card key={project.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <h3 className="font-medium">{project.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(project.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/${project.id}/traces`}>
                      <Button variant="outline" size="sm">
                        Go to project
                      </Button>
                    </Link>
                    {canDeleteProject(org.role) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          if (confirm(`Delete project "${project.name}"?`)) {
                            deleteProjectMutation.mutate(project.id);
                          }
                        }}
                        disabled={deleteProjectMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Members Section */}
        {canManageMembers(org.role) && members && members.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4" />
              Members ({members.length})
            </h2>
            <Card>
              <CardContent className="divide-y p-0">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {member.name || member.email || "Unknown"}
                      </p>
                      {member.name && (
                        <p className="text-xs text-muted-foreground">
                          {member.email}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          roleColors[member.role] || roleColors.VIEWER
                        }`}
                      >
                        {member.role}
                      </span>
                      {member.user_id !== user?.id && member.role !== "OWNER" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (
                              confirm(
                                `Remove ${member.name || member.email} from the organization?`
                              )
                            ) {
                              removeMemberMutation.mutate(member.user_id);
                            }
                          }}
                          disabled={removeMemberMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
