"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowLeft, Settings } from "lucide-react";
import { getOrganization } from "@/lib/api";
import { useHasOrganizationAccess } from "@/hooks/useOrgAccess";
import {
  PagedSettingsContainer,
  SettingsPage,
} from "@/components/PagedSettingsContainer";
import { RenameOrganization } from "@/components/RenameOrganization";
import { DeleteOrganizationButton } from "@/components/DeleteOrganizationButton";
import { MembersTable } from "@/components/MembersTable";
import { PendingInvitations } from "@/components/PendingInvitations";
import { InviteMemberDialog } from "@/components/InviteMemberDialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function OrganizationSettingsPage() {
  const params = useParams();
  const orgId = params.orgId as string;

  const {
    data: org,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: !!orgId,
  });

  const canUpdate = useHasOrganizationAccess({
    orgId,
    scope: "organization:update",
  });
  const canDelete = useHasOrganizationAccess({
    orgId,
    scope: "organization:delete",
  });
  const canManageMembers = useHasOrganizationAccess({
    orgId,
    scope: "organizationMembers:CUD",
  });
  const canViewMembers = useHasOrganizationAccess({
    orgId,
    scope: "organizationMembers:read",
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  if (error || !org) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">
            {error?.message || "Organization not found"}
          </p>
          <Link
            href="/organizations"
            className="mt-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Organizations
          </Link>
        </div>
      </div>
    );
  }

  const pages: SettingsPage[] = [
    {
      title: "General",
      slug: "general",
      show: canUpdate,
      content: (
        <div className="space-y-6">
          <RenameOrganization orgId={orgId} currentName={org.name} />

          {/* Organization ID (read-only) */}
          <Card>
            <CardHeader>
              <CardTitle>Organization ID</CardTitle>
              <CardDescription>
                Use this ID when configuring integrations
              </CardDescription>
            </CardHeader>
            <CardContent>
              <code className="rounded bg-gray-100 px-2 py-1 text-sm">
                {orgId}
              </code>
            </CardContent>
          </Card>

          {/* Danger Zone */}
          {canDelete && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-destructive">Danger Zone</CardTitle>
                <CardDescription>
                  Irreversible actions that will permanently affect your
                  organization
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DeleteOrganizationButton orgId={orgId} orgName={org.name} />
              </CardContent>
            </Card>
          )}
        </div>
      ),
    },
    {
      title: "Members",
      slug: "members",
      show: canViewMembers,
      content: (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Organization Members</h2>
              <p className="text-sm text-muted-foreground">
                Manage who has access to this organization
              </p>
            </div>
            {canManageMembers && <InviteMemberDialog orgId={orgId} />}
          </div>

          <MembersTable orgId={orgId} />

          <PendingInvitations orgId={orgId} />
        </div>
      ),
    },
  ];

  // Filter out pages that shouldn't be shown
  const visiblePages = pages.filter((p) => p.show !== false);

  // If no pages are visible, show a message
  if (visiblePages.length === 0) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Link
          href={`/organizations/${orgId}`}
          className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          Back to {org.name}
        </Link>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              You don&apos;t have permission to view settings for this
              organization
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

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
          <h1 className="text-2xl font-bold">Organization Settings</h1>
          <p className="text-sm text-muted-foreground">{org.name}</p>
        </div>
      </div>

      {/* Settings content */}
      <PagedSettingsContainer
        pages={visiblePages}
        basePath={`/organizations/${orgId}/settings`}
      />
    </div>
  );
}
