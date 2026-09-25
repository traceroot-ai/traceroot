"use client";

/**
 * Data hooks for the filter builder: the field registry that drives the pill list,
 * the lazy distinct-values for a categorical field (fetched only once that field
 * is picked), and the metadata keys observed in the active window. All mirror the
 * trace-list hook conventions (auth session + React Query).
 */
import { useQuery } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import type { TraceApiUser } from "@/lib/api/client";
import type { MetadataKey } from "@/types/api";
import { getFilterFields, getFilterValues, getMetadataKeys } from "@/lib/api/traces";
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

/**
 * Metadata keys observed in the active window, frequency-ordered, feeding the metadata
 * filter's key combobox — its one consumer. The trace list's column picker never calls
 * this: it offers fixed fields only, and metadata reaches the list as a single blob cell.
 *
 * Keyed on project and window like the distinct-values hook, and cached with the same 30s
 * staleness: the window is what the answer is about, so changing it must fetch a new list
 * rather than reuse the previous window's keys. Suggestion is not permission — a key missing
 * from this list is still filterable by typing it.
 *
 * `enabled` is not where the laziness comes from: every call site passes it true, and the
 * fetch stays lazy only because `MetadataKeyCombobox` mounts for a metadata predicate and
 * not otherwise. Contrast `useFilterValues` above, where `enabled` is the real gate on a
 * control that is already mounted.
 */
export function useMetadataKeys(
  projectId: string,
  startAfter: string | undefined,
  endBefore: string | undefined,
  enabled: boolean = true,
): { keys: MetadataKey[]; isLoading: boolean } {
  const { user, sessionReady } = useApiUser();
  const active = sessionReady && !!projectId && enabled;
  const { data, isLoading } = useQuery({
    queryKey: ["metadata-keys", projectId, startAfter ?? null, endBefore ?? null],
    queryFn: () => getMetadataKeys(projectId, startAfter, endBefore, user),
    enabled: active,
    staleTime: 30_000,
  });
  return active ? { keys: data?.keys ?? [], isLoading } : { keys: [], isLoading: false };
}
