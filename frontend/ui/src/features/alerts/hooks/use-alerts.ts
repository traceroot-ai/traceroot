import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AlertAggregation,
  AlertFilter,
  AlertNoDataMode,
  AlertRenotify,
  AlertSeverity,
  AlertStatus,
  AlertThresholdOperator,
  AlertView,
  AlertWindow,
} from "@traceroot/core";
import { ApiError } from "@/lib/api/client";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import type { AlertCapacity } from "../capacity";

/** The row shape the list endpoint returns — the rule plus its evaluation state. */
export interface AlertSummary {
  id: string;
  name: string;
  view: AlertView;
  measure: string;
  aggregation: AlertAggregation;
  window: AlertWindow;
  thresholdOperator: AlertThresholdOperator;
  threshold: number;
  status: AlertStatus;
  severity: AlertSeverity;
  severityChangedAt: string | null;
  alertedAt: string | null;
  /** The last successful evaluation; a failed run leaves it where it was. */
  lastEvaluatedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastNotifyStatus: string | null;
  lastNotifyError: string | null;
  lastNotifyAt: string | null;
  createTime: string;
  updateTime: string;
  creator: string | null;
}

/** One alert in full: the list row plus the fields only the detail select returns. */
export interface AlertRecord extends AlertSummary {
  filters: AlertFilter[];
  renotify: AlertRenotify;
  noDataMode: AlertNoDataMode;
}

/** The rule body the create endpoint accepts; mirrors `alertCreateSchema`. */
export interface AlertCreateInput {
  name: string;
  view: AlertView;
  measure: string;
  aggregation: AlertAggregation;
  filters: AlertFilter[];
  window: AlertWindow;
  thresholdOperator: AlertThresholdOperator;
  threshold: number;
  renotify: AlertRenotify;
  noDataMode?: AlertNoDataMode;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  /** Optional: a response cached before the field shipped carries no capacity. */
  capacity?: AlertCapacity;
}

interface AlertListQuery {
  page?: number;
  limit?: number;
  search_query?: string;
}

interface AlertListResponse {
  data: AlertSummary[];
  meta: PaginationMeta;
}

const ALERTS_QUERY_PREFIX = "alerts";

// The evaluator ticks once a minute, so severity cannot change faster; 30s
// keeps the list within one tick of the truth.
const ALERT_LIST_POLL_MS = 30_000;

async function readError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}) as { detail?: string; error?: string });
  throw new ApiError(res.status, body.detail ?? body.error ?? fallback);
}

async function fetchAlertList(
  projectId: string,
  query: AlertListQuery = {},
): Promise<AlertListResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.search_query) params.set("search_query", query.search_query);

  const qs = params.toString();
  const res = await fetch(`/api/projects/${projectId}/alerts${qs ? `?${qs}` : ""}`);
  if (!res.ok) await readError(res, `Failed to fetch alerts: ${res.status}`);
  return res.json() as Promise<AlertListResponse>;
}

async function fetchAlert(projectId: string, alertId: string): Promise<AlertRecord> {
  const res = await fetch(`/api/projects/${projectId}/alerts/${alertId}`);
  if (!res.ok) await readError(res, `Failed to fetch alert: ${res.status}`);
  const body = (await res.json()) as { alert: AlertRecord };
  return body.alert;
}

async function createAlert(projectId: string, input: AlertCreateInput): Promise<AlertSummary> {
  const res = await fetch(`/api/projects/${projectId}/alerts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await readError(res, `Failed to create alert: ${res.status}`);
  const body = (await res.json()) as { alert: AlertSummary };
  return body.alert;
}

async function updateAlert(
  projectId: string,
  alertId: string,
  input: AlertCreateInput,
): Promise<AlertRecord> {
  const res = await fetch(`/api/projects/${projectId}/alerts/${alertId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await readError(res, `Failed to update alert: ${res.status}`);
  const body = (await res.json()) as { alert: AlertRecord };
  return body.alert;
}

async function deleteAlert(projectId: string, alertId: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/alerts/${alertId}`, { method: "DELETE" });
  if (!res.ok) await readError(res, `Failed to delete alert: ${res.status}`);
}

async function setAlertStatus(
  projectId: string,
  alertId: string,
  status: AlertStatus,
): Promise<AlertSummary> {
  const res = await fetch(`/api/projects/${projectId}/alerts/${alertId}/pause`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) await readError(res, `Failed to update alert: ${res.status}`);
  const body = (await res.json()) as { alert: AlertSummary };
  return body.alert;
}

export function useAlertList(projectId: string, query: AlertListQuery = {}) {
  return useQuery({
    queryKey: [
      ALERTS_QUERY_PREFIX,
      "list",
      projectId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
    ],
    queryFn: () => fetchAlertList(projectId, query),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
    refetchInterval: ALERT_LIST_POLL_MS,
  });
}

// Its own key rather than a read off the list query: that one is scoped to the
// page and the search keyword, neither of which the cap cares about.
export function useAlertCapacity(projectId: string) {
  return useQuery({
    queryKey: [ALERTS_QUERY_PREFIX, "capacity", projectId],
    queryFn: () => fetchAlertList(projectId, { limit: 1 }),
    enabled: !!projectId,
    select: (response: AlertListResponse) => response.meta.capacity,
  });
}

// requireWorkspaceMembership's role refusal shares 403 with revoked access;
// the message is the only signal the routes emit that separates them.
const ROLE_DENIAL_MESSAGE = /^Requires [A-Z]+ role or higher$/;

/**
 * A rule that has been deleted, or a workspace whose access was revoked. A 403
 * role denial is neither: the rule still exists, the caller just may not
 * mutate it.
 */
export function isAlertGone(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404) return true;
  return error.status === 403 && !ROLE_DENIAL_MESSAGE.test(error.message);
}

// Deliberately unpolled: a refetch landing mid-edit would be a rule under the
// user's hands changing out from under them.
export function useAlert(projectId: string, alertId: string) {
  return useQuery({
    queryKey: [ALERTS_QUERY_PREFIX, "detail", projectId, alertId],
    queryFn: () => fetchAlert(projectId, alertId),
    enabled: !!projectId && !!alertId,
  });
}

function invalidateAlerts(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: [ALERTS_QUERY_PREFIX] });
  broadcastQueryInvalidation([ALERTS_QUERY_PREFIX]);
}

export function useCreateAlert(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AlertCreateInput) => createAlert(projectId, input),
    onSuccess: () => invalidateAlerts(queryClient),
  });
}

export function useUpdateAlert(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, input }: { alertId: string; input: AlertCreateInput }) =>
      updateAlert(projectId, alertId, input),
    onSuccess: () => invalidateAlerts(queryClient),
  });
}

export function useDeleteAlert(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) => deleteAlert(projectId, alertId),
    onSuccess: () => invalidateAlerts(queryClient),
  });
}

export function useSetAlertStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ alertId, status }: { alertId: string; status: AlertStatus }) =>
      setAlertStatus(projectId, alertId, status),
    onSuccess: () => invalidateAlerts(queryClient),
  });
}
