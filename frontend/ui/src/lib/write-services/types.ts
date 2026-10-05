import type { AuditEntry } from "./audit";

/** Where a write originated: the public REST API, an agent acting for a user,
 *  or the web app's own cookie-session routes. */
export interface Provenance {
  transport: "public-api" | "agent" | "ui";
  agentSessionId?: string | null;
}

export type ServiceResult<T> =
  | {
      ok: true;
      created: boolean;
      data: T;
      /** The name the caller asked for, when the service created the resource
       *  under a different one because that name was already taken (agent
       *  dashboard creates); absent when the requested name was used. */
      renamedFrom?: string;
    }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * What a partial update answers. `changed` lists the public snake_case names
 * of the fields whose stored value actually differs after the write; an empty
 * list means nothing was written and nothing was audited, so a retried
 * command is harmless. `stateReset` and `pageCleared` are alert-only: the
 * edit voided the evaluation state, and the state it voided held an open page.
 */
export type UpdateResult<T> =
  | { ok: true; data: T; changed: string[]; stateReset?: boolean; pageCleared?: boolean }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * What an update or delete transaction returns: the answer plus the audit
 * entry to record once the transaction has committed. Writing the audit row
 * inside the transaction would let a failed INSERT abort it and discard the
 * write the caller was told succeeded.
 */
export type EditOutcome<R> = Promise<{ result: R; audit?: AuditEntry }>;

/**
 * What a delete answers. `reason` echoes the caller's required statement of
 * why; `cascaded` counts what went with the row where a cascade applies
 * (a workspace's projects, a dashboard's widgets); `pageCleared` is alert-only.
 * A 400 is the service refusing the reason itself, so no surface can skip it.
 */
export type DeleteResult =
  | {
      ok: true;
      data: { id: string; name: string };
      reason: string;
      cascaded?: Record<string, number>;
      pageCleared?: boolean;
    }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };
