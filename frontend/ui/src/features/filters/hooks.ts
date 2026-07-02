"use client";

/**
 * Data hooks for the filter builder: the field registry that drives the pill list,
 * and the lazy distinct-values for a categorical field (fetched only once that field
 * is picked). Both mirror the trace-list hook conventions (auth session + React Query).
 */
import { useQuery } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import type { TraceApiUser } from "@/lib/api/client";
import { getFilterFields, getFilterValues } from "@/lib/api/traces";
import { STATIC_FILTER_FIELDS, type FilterFieldDef, type FilterValue } from "./registry";

function useApiUser() {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return { user, sessionReady };
}

/**
 * The filterable-field registry. Falls back to the static list (so the builder paints
 * immediately) until the live `/filter-fields` payload resolves, then uses that.
 */
export function useFilterFields(projectId: string): FilterFieldDef[] {
  const { user, sessionReady } = useApiUser();
  const { data } = useQuery({
    queryKey: ["filter-fields", projectId],
    queryFn: () => getFilterFields(projectId, user),
    enabled: sessionReady && !!projectId,
    staleTime: Infinity,
  });
  return data?.fields ?? STATIC_FILTER_FIELDS;
}

/**
 * Distinct values for a categorical field, fetched lazily (only when `enabled`, i.e.
 * once the field is picked) and bounded by the active time window.
 */
export function useFilterValues(
  projectId: string,
  field: string | null,
  startAfter: string | undefined,
  endBefore: string | undefined,
  enabled: boolean,
): { values: FilterValue[]; isLoading: boolean } {
  const { user, sessionReady } = useApiUser();
  const active = sessionReady && !!projectId && !!field && enabled;
  const { data, isLoading } = useQuery({
    queryKey: ["filter-values", projectId, field, startAfter ?? null, endBefore ?? null],
    queryFn: () => getFilterValues(projectId, field!, startAfter, endBefore, user),
    enabled: active,
    staleTime: 30_000,
  });
  // Mask React Query's retained cache while disabled so the lazy contract holds: a
  // not-yet-active field reports no values rather than a previously-fetched field's.
  return active ? { values: data?.values ?? [], isLoading } : { values: [], isLoading: false };
}
