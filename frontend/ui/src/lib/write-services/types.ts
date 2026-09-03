/** Where a write originated: the public REST API or an agent acting for a user. */
export interface Provenance {
  transport: "public-api" | "agent";
  agentSessionId?: string | null;
}

export type ServiceResult<T> =
  | { ok: true; created: boolean; data: T }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };
