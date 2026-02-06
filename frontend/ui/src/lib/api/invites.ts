/**
 * Invite API functions
 */
import { fetchNextApi } from "./client";
import type { Invite, Role } from "@/types/api";

export async function getInvites(workspaceId: string): Promise<Invite[]> {
  const response = await fetchNextApi<{ invites: Invite[] }>(`/workspaces/${workspaceId}/invites`);
  return response.invites;
}

export async function createInvite(workspaceId: string, email: string, role: Role): Promise<Invite> {
  return fetchNextApi<Invite>(`/workspaces/${workspaceId}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function cancelInvite(workspaceId: string, inviteId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}/invites/${inviteId}`, {
    method: "DELETE",
  });
}

export async function acceptInvite(inviteId: string): Promise<{ workspace: { id: string; name: string }; role: Role }> {
  return fetchNextApi<{ workspace: { id: string; name: string }; role: Role }>(`/invites/${inviteId}/accept`, {
    method: "POST",
  });
}
