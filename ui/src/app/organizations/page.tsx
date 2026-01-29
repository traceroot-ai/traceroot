"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CreateOrgDialog } from "@/components/CreateOrgDialog";
import { useLayout } from "@/components/layout/app-layout";
import { LayoutGrid, Rocket, BookOpen, ArrowRight } from "lucide-react";
import Link from "next/link";

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
      <span className="text-sm font-medium">Organizations</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

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
        <p className="text-destructive">
          Error loading organizations: {error.message}
        </p>
      </div>
    );
  }

  const hasOrganizations = organizations && organizations.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Page Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Organizations</h1>
          {hasOrganizations && <CreateOrgDialog />}
        </div>

        {/* Empty State - Get Started Card */}
        {!hasOrganizations && (
          <Card className="border-dashed">
            <CardContent className="p-6">
              <div className="flex items-start gap-5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Rocket className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <h2 className="font-medium">Get Started</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Create an organization to start tracking your AI agents.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <CreateOrgDialog />
                    <Link
                      href="https://docs.traceroot.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Button variant="outline" size="sm">
                        <BookOpen className="mr-2 h-4 w-4" />
                        Docs
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Organizations List */}
        {hasOrganizations && (
          <div className="space-y-3">
            {organizations.map((org) => (
              <Card
                key={org.id}
                className="group transition-colors hover:bg-accent/50"
              >
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <LayoutGrid className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">{org.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {org.role.toLowerCase()}
                      </p>
                    </div>
                  </div>
                  <Link href={`/organizations/${org.id}`}>
                    <Button variant="outline" size="sm">
                      Go to organization
                      <ArrowRight className="ml-2 h-3 w-3" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
