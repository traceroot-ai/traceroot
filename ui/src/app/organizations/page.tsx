"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CreateOrgDialog } from "@/components/CreateOrgDialog";
import { Building2, ChevronRight, Users } from "lucide-react";
import Link from "next/link";
import { Settings } from "lucide-react";

const roleColors: Record<string, string> = {
  OWNER: "bg-purple-100 text-purple-800",
  ADMIN: "bg-blue-100 text-blue-800",
  MEMBER: "bg-green-100 text-green-800",
  VIEWER: "bg-gray-100 text-gray-800",
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

  const {
    data: organizations,
    isLoading,
    error,
  } = useQuery({
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
        <p className="text-destructive">
          Error loading organizations: {error.message}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl p-6">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Organizations</h1>
            <p className="text-muted-foreground">
              Manage your organizations and projects
            </p>
          </div>
          <CreateOrgDialog />
        </div>

        {organizations && organizations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
              <h3 className="mb-2 text-lg font-medium">No organizations yet</h3>
              <p className="mb-4 text-muted-foreground">
                Create your first organization to get started.
              </p>
              <CreateOrgDialog />
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {organizations?.map((org) => (
              <Link
                key={org.id}
                href={`/organizations/${org.id}`}
                className="block"
              >
                <Card className="relative cursor-pointer transition-shadow hover:shadow-md">
                  {/* Settings icon - top right */}
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      window.location.href = `/organizations/${org.id}/settings`;
                    }}
                    className="absolute right-6 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 hover:text-foreground"
                  >
                    <Settings className="h-4 w-4" />
                  </button>

                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                        <Building2 className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{org.name}</CardTitle>
                        <CardDescription>
                          Created{" "}
                          {new Date(org.created_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          roleColors[org.role] || roleColors.VIEWER
                        }`}
                      >
                        {org.role}
                      </span>
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
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
