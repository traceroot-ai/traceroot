"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, type Organization } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { useLayout } from "@/components/layout/app-layout";
import { Building2, Settings } from "lucide-react";
import Link from "next/link";
import { CreateOrgDialog } from "@/components/CreateOrgDialog";

function OrgCard({ org }: { org: Organization }) {
  const router = useRouter();

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
      onClick={() => router.push(`/organizations/${org.id}/projects`)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <h3 className="font-medium text-[13px]">{org.name}</h3>
          <Link
            href={`/organizations/${org.id}/settings`}
            onClick={(e) => e.stopPropagation()}
            className="p-1 hover:bg-muted rounded transition-colors"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          </Link>
        </div>
        <div className="flex gap-4 text-[11px] text-muted-foreground">
          <span>Created {new Date(org.created_at).toLocaleDateString()}</span>
          <span>Updated {new Date(org.updated_at).toLocaleDateString()}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function OrganizationsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <span className="text-[13px] font-medium">Organizations</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  // Get all organizations
  const { data: organizations, isLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: status === "authenticated",
  });

  if (!user) {
    return null;
  }

  return (
    <div className="h-full bg-background overflow-auto">
      <div className="p-4">
        {/* Section header with title and button */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold">Organizations</h1>
            <p className="text-[13px] text-muted-foreground">Manage your organizations and teams</p>
          </div>
          <CreateOrgDialog />
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-muted-foreground text-[13px]">Loading organizations...</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && (!organizations || organizations.length === 0) && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <Building2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1 text-[13px]">No organizations yet</h3>
              <p className="text-[12px] text-muted-foreground mb-4 text-center">
                Create your first organization to get started
              </p>
              <CreateOrgDialog />
            </div>
          </div>
        )}

        {/* Organizations Grid */}
        {!isLoading && organizations && organizations.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {organizations.map((org) => (
              <OrgCard key={org.id} org={org} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
