/** Where a write originated: the public REST API or an agent acting for a user. */
export interface Provenance {
  transport: "public-api" | "agent";
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
  | { ok: false; status: 400 | 403 | 404; error: string };
