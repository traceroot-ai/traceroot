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
import { Rocket, BookOpen } from "lucide-react";
import Link from "next/link";

export default function Home() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { setHeaderContent } = useLayout();

  const { data: organizations, isLoading: orgsLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: status === "authenticated",
  });

  useEffect(() => {
    if (organizations && organizations.length > 0) {
      router.push("/organizations");
    }
  }, [organizations, router]);

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <span className="text-sm font-medium">Organizations</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    router.push("/auth/sign-in");
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Redirecting to sign in...</p>
      </div>
    );
  }

  if (orgsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading organizations...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-6 py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">
            Organizations
          </h1>
        </div>

        {/* Get Started Card */}
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
      </div>
    </div>
  );
}                                                         