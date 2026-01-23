"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getOrganizations, getUser, setUser } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateOrgDialog } from "@/components/CreateOrgDialog";

export default function Home() {
  const router = useRouter();
  const [user, setUserState] = useState<{ id: string; email: string; name?: string } | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const currentUser = getUser();
    if (currentUser) {
      setUserState(currentUser);
    }
    setIsLoading(false);
  }, []);

  const { data: organizations, isLoading: orgsLoading } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: !!user,
  });

  useEffect(() => {
    if (organizations && organizations.length > 0) {
      router.push("/organizations");
    }
  }, [organizations, router]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      const id = `user_${Date.now()}`;
      setUser(id, email.trim(), name.trim() || undefined);
      setUserState({ id, email: email.trim(), name: name.trim() || undefined });
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  // Not logged in - show login form
  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Welcome to Traceroot</CardTitle>
            <CardDescription>
              AI Observability Platform - Sign in to continue
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Input
                placeholder="Name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </form>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              This is a demo auth flow. In production, use NextAuth or similar.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Logged in but loading orgs
  if (orgsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading organizations...</p>
      </div>
    );
  }

  // Logged in but no organizations - show welcome/create org
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome, {user.name || user.email}!</CardTitle>
          <CardDescription>
            Create your first organization to get started.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <CreateOrgDialog />
        </CardContent>
      </Card>
    </div>
  );
}
