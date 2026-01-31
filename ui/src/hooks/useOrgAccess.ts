"use client";

import { useQuery } from "@tanstack/react-query";
import { getOrganization, Role } from "@/lib/api";
import { hasOrgPermission, OrganizationScope } from "@/lib/rbac";

interface UseOrgAccessOptions {
  orgId: string;
  scope: OrganizationScope;
}

export function useHasOrganizationAccess({
  orgId,
  scope,
}: UseOrgAccessOptions): boolean {
  const { data: org } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  if (!org) return false;
  return hasOrgPermission(org.role, scope);
}

// Hook to get current user's role in an organization
export function useOrgRole(orgId: string): Role | null {
  const { data: org } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  return org?.role ?? null;
}
