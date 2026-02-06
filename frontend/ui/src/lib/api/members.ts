/**
 * Member API functions
 */
import { fetchNextApi } from "./client";
import type { Member, Role } from "@/types/api";

export async function getMembers(workspaceId: string): Promise<Member[]> {
  const response = await fetchNextApi<{ members: Member[] }>(`/workspaces/${workspaceId}/members`);
  return response.members;
}

export async function addMember(workspaceId: string, userId: string, role: Role): Promise<Member> {
  return fetchNextApi<Member>(`/workspaces/${workspaceId}/members`, {
    method: "POST",
    body: JSON.stringify({ userId, role }),
  });
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: Role
): Promise<Member> {
  return fetchNextApi<Member>(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
}
