"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateOrganization } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface RenameOrganizationProps {
  orgId: string;
  currentName: string;
}

export function RenameOrganization({
  orgId,
  currentName,
}: RenameOrganizationProps) {
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (newName: string) => updateOrganization(orgId, newName),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
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

  const hasChanges = name.trim() !== currentName;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization Name</CardTitle>
        <CardDescription>
          Update your organization&apos;s display name
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
              placeholder="Organization name"
              disabled={mutation.isPending}
            />
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
          </div>
          <Button
            type="submit"
            disabled={!name.trim() || !hasChanges || mutation.isPending}
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
