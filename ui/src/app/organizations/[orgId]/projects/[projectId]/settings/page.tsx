"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, Settings, Copy, Check } from "lucide-react";
import {
  getOrganization,
  updateProject,
  deleteProject,
  getApiKeys,
  createApiKey,
  deleteApiKey,
  type ApiKey,
} from "@/lib/api";
import { useHasOrganizationAccess } from "@/hooks/useOrgAccess";
import {
  PagedSettingsContainer,
  SettingsPage,
} from "@/components/PagedSettingsContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Plus, Key } from "lucide-react";
import { ProjectMembersTable } from "@/components/ProjectMembersTable";

// =============================================================================
// Rename Project Component
// =============================================================================

function RenameProject({
  orgId,
  projectId,
  currentName,
}: {
  orgId: string;
  projectId: string;
  currentName: string;
}) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (newName: string) => updateProject(orgId, projectId, newName),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== currentName) {
      mutation.mutate(trimmedName);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Project Name</CardTitle>
        <CardDescription>
          Update your project&apos;s display name
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 sm:flex-row sm:items-start"
        >
          <div className="flex-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              disabled={mutation.isPending}
            />
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          </div>
          <Button
            type="submit"
            disabled={
              !name.trim() || name.trim() === currentName || mutation.isPending
            }
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Delete Project Component
// =============================================================================

function DeleteProjectButton({
  orgId,
  projectId,
  projectName,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteProject(orgId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
      setOpen(false);
      window.location.href = `/organizations/${orgId}`;
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive">Delete Project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Project</DialogTitle>
          <DialogDescription>
            This will permanently delete the project, all traces, and API keys.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-3 text-sm">
            Type <strong className="select-all">{projectName}</strong> to
            confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Project name"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={confirmText !== projectName || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Deleting..." : "Delete Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// API Keys Component
// =============================================================================

function ApiKeysSection({ projectId }: { projectId: string }) {
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const { data: apiKeysResponse, isLoading } = useQuery({
    queryKey: ["apiKeys", projectId],
    queryFn: () => getApiKeys(projectId),
  });

  const apiKeys = apiKeysResponse?.data || [];

  const createMutation = useMutation({
    mutationFn: () => createApiKey(projectId, newKeyName || undefined),
    onSuccess: (response) => {
      setCreatedKey(response.data.key);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: ["apiKeys", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteApiKey(projectId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["apiKeys", projectId] });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Create new key */}
      <Card>
        <CardHeader>
          <CardTitle>Create API Key</CardTitle>
          <CardDescription>
            API keys are used to authenticate requests from your application
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="flex gap-2"
          >
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="Key name (optional)"
              className="max-w-xs"
            />
            <Button type="submit" disabled={createMutation.isPending}>
              <Plus className="mr-2 h-4 w-4" />
              {createMutation.isPending ? "Creating..." : "Create Key"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Show newly created key */}
      {createdKey && (
        <Card className="border-green-200 bg-green-50">
          <CardHeader>
            <CardTitle className="text-green-800">API Key Created</CardTitle>
            <CardDescription className="text-green-700">
              Copy this key now. You won&apos;t be able to see it again!
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-white px-3 py-2 text-sm font-mono border">
                {createdKey}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(createdKey)}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setCreatedKey(null)}
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* List existing keys */}
      <Card>
        <CardHeader>
          <CardTitle>Existing API Keys</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : apiKeys.length === 0 ? (
            <p className="text-muted-foreground">No API keys yet</p>
          ) : (
            <div className="divide-y">
              {apiKeys.map((key: ApiKey) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex items-center gap-3">
                    <Key className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium">{key.name || "Unnamed key"}</p>
                      <p className="text-sm text-muted-foreground">
                        {key.key_prefix}••••••••
                        {key.last_used_at && (
                          <>
                            {" "}
                            · Last used{" "}
                            {new Date(key.last_used_at).toLocaleDateString()}
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (confirm("Delete this API key?")) {
                        deleteMutation.mutate(key.id);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// =============================================================================
// Main Project Settings Page
// =============================================================================

export default function ProjectSettingsPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const projectId = params.projectId as string;

  const { data: org, isLoading } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
  });

  const canUpdate = useHasOrganizationAccess({
    orgId,
    scope: "projects:delete",
  });

  const project = org?.projects.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!org || !project) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">Project not found</p>
          <Link
            href={`/organizations/${orgId}`}
            className="mt-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Organization
          </Link>
        </div>
      </div>
    );
  }

  const pages: SettingsPage[] = [
    {
      title: "General",
      slug: "general",
      content: (
        <div className="space-y-6">
          <RenameProject
            orgId={orgId}
            projectId={projectId}
            currentName={project.name}
          />

          {/* Project ID */}
          <Card>
            <CardHeader>
              <CardTitle>Project ID</CardTitle>
              <CardDescription>
                Use this ID when configuring the SDK
              </CardDescription>
            </CardHeader>
            <CardContent>
              <code className="rounded bg-gray-100 px-2 py-1 text-sm">
                {projectId}
              </code>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          {canUpdate && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-destructive">Danger Zone</CardTitle>
                <CardDescription>
                  Permanently delete this project and all its data
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DeleteProjectButton
                  orgId={orgId}
                  projectId={projectId}
                  projectName={project.name}
                />
              </CardContent>
            </Card>
          )}
        </div>
      ),
    },
    {
      title: "API Keys",
      slug: "api-keys",
      content: <ApiKeysSection projectId={projectId} />,
    },
    {
      title: "Members",
      slug: "members",
      content: (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Project Members</h2>
            <p className="text-sm text-muted-foreground">
              Set project-specific role overrides. &quot;Inherit&quot; uses the
              organization role.
            </p>
          </div>
          <ProjectMembersTable projectId={projectId} orgId={orgId} />
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-4xl p-6">
      {/* Back link */}
      <Link
        href={`/organizations/${orgId}`}
        className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 h-4 w-4" />
        Back to {org.name}
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
          <Settings className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Project Settings</h1>
          <p className="text-sm text-muted-foreground">{project.name}</p>
        </div>
      </div>

      {/* Settings content */}
      <PagedSettingsContainer
        pages={pages}
        basePath={`/organizations/${orgId}/projects/${projectId}/settings`}
      />
    </div>
  );
}
