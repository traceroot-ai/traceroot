"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations} from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateOrgDialog } from "@/components/CreateOrgDialog";
import { Building2, ChevronRight, Users } from "lucide-react";
import Link from "next/link";

const roleColors: Record<string, string> = {
  OWNER: "bg-gray-900 text-white",
  ADMIN: "bg-gray-700 text-white",
  MEMBER: "bg-gray-200 text-gray-800",
  VIEWER: "bg-gray-100 text-gray-600",
};

export default function OrganizationsPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const user = session?.user;

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  const { data: organizations, isLoading, error } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: status === "authenticated",
  });

  if (!user) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading organizations...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-destructive">Error loading organizations: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-6 py-4">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Organizations</h1>
            <p className="text-sm text-muted-foreground">
              Manage your organizations and projects
            </p>
          </div>
          <CreateOrgDialog />
        </div>

        {organizations && organizations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Building2 className="mb-3 h-10 w-10 text-muted-foreground" />
              <h3 className="mb-1 text-base font-medium">No organizations yet</h3>
              <p className="mb-3 text-sm text-muted-foreground">
                Create your first organization to get started.
              </p>
              <CreateOrgDialog />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {organizations?.map((org) => (
              <Link key={org.id} href={`/organizations/${org.id}`}>
                <Card className="cursor-pointer transition-all hover:bg-gray-50 hover:border-gray-300">
                  <CardHeader className="flex flex-row items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gray-100">
                        <Building2 className="h-4 w-4 text-gray-600" />
                      </div>
                      <div>
                        <CardTitle className="text-sm font-medium">{org.name}</CardTitle>
                        <CardDescription className="text-xs">
                          Created {new Date(org.created_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          roleColors[org.role] || roleColors.VIEWER
                        }`}
                      >
                        {org.role}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
