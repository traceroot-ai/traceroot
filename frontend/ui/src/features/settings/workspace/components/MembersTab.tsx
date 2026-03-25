"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AddButton } from "@/components/ui/add-button";
import { DeleteIconButton } from "@/components/ui/delete-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Role } from "@traceroot/core";
import {
  getWorkspace,
  getMembers,
  updateMemberRole,
  removeMember,
  getInvites,
  createInvite,
  cancelInvite,
  type Member,
  type Invite,
} from "@/lib/api";
import { useSession } from "@/lib/auth-client";

interface MembersTabProps {
  workspaceId: string;
}

export function MembersTab({ workspaceId }: MembersTabProps) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const [showInviteMember, setShowInviteMember] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<Role>(Role.MEMBER);
  const [editingMember, setEditingMember] = useState<{ userId: string; role: Role } | null>(null);

  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () => getMembers(workspaceId),
  });

  const { data: invites = [], isLoading: invitesLoading } = useQuery({
    queryKey: ["invites", workspaceId],
    queryFn: () => getInvites(workspaceId),
  });

  const inviteMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) =>
      createInvite(workspaceId, email, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invites", workspaceId] });
      setShowInviteMember(false);
      setNewMemberEmail("");
      setNewMemberRole(Role.MEMBER);
    },
  });

  const cancelInviteMutation = useMutation({
    mutationFn: (inviteId: string) => cancelInvite(workspaceId, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invites", workspaceId] });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      updateMemberRole(workspaceId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", workspaceId] });
      setEditingMember(null);
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeMember(workspaceId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", workspaceId] });
    },
  });

  const handleInviteMember = () => {
    if (newMemberEmail.trim()) {
      inviteMutation.mutate({ email: newMemberEmail.trim(), role: newMemberRole });
    }
  };

  const handleUpdateRole = () => {
    if (editingMember) {
      updateRoleMutation.mutate(editingMember);
    }
  };

  const roleOptions: Role[] = [Role.ADMIN, Role.MEMBER, Role.VIEWER];
  const canManageMembers = workspace?.role === Role.ADMIN;
  const adminCount = members.filter((m: Member) => m.role === Role.ADMIN).length;
  const isLastAdmin = workspace?.role === Role.ADMIN && adminCount <= 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">Manage workspace members and invitations</p>
        </div>
        {canManageMembers && (
          <AddButton onClick={() => setShowInviteMember(true)}>Invite member</AddButton>
        )}
      </div>

      <Dialog open={showInviteMember} onOpenChange={setShowInviteMember}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite New Member</DialogTitle>
            <DialogDescription>
              Send an invitation to a new member. They will receive an email to join this workspace.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="mb-2 block text-sm font-medium">Email</label>
              <Input
                placeholder="member@example.com"
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                type="email"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">Role</label>
              <Select
                value={newMemberRole}
                onValueChange={(value) => setNewMemberRole(value as Role)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role.charAt(0) + role.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteMutation.isError && (
              <p className="text-sm text-destructive">{inviteMutation.error.message}</p>
            )}
          </div>
          <DialogFooter className="sm:justify-center">
            <Button
              onClick={handleInviteMember}
              disabled={!newMemberEmail.trim() || inviteMutation.isPending}
            >
              {inviteMutation.isPending ? "Sending..." : "Send Invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>Update the member&apos;s role in this workspace.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="mb-2 block text-sm font-medium">Role</label>
            <Select
              value={editingMember?.role || Role.MEMBER}
              onValueChange={(value) =>
                setEditingMember(editingMember ? { ...editingMember, role: value as Role } : null)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role.charAt(0) + role.slice(1).toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="sm:justify-center">
            <Button onClick={handleUpdateRole} disabled={updateRoleMutation.isPending}>
              {updateRoleMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!invitesLoading && invites.length > 0 && (
        <div className="border">
          <div className="border-b bg-muted/30 px-4 py-3">
            <h3 className="text-sm font-medium">Pending Invitations</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Role</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Invited By</th>
                {canManageMembers && (
                  <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {invites.map((invite: Invite) => (
                <tr key={invite.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-2">{invite.email}</td>
                  <td className="px-4 py-2">
                    {invite.role.charAt(0) + invite.role.slice(1).toLowerCase()}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {invite.invited_by?.name || invite.invited_by?.email || "-"}
                  </td>
                  {canManageMembers && (
                    <td className="px-4 py-2">
                      <DeleteIconButton
                        onClick={() => cancelInviteMutation.mutate(invite.id)}
                        disabled={cancelInviteMutation.isPending}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Members</h3>
        </div>
        {membersLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No members found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10 text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Role</th>
                {canManageMembers && (
                  <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member: Member) => (
                <tr key={member.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-2">
                    {member.name || <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{member.email || "-"}</td>
                  <td className="px-4 py-2">
                    {canManageMembers ? (
                      <button
                        onClick={() =>
                          setEditingMember({ userId: member.user_id, role: member.role })
                        }
                        className="cursor-pointer hover:underline"
                      >
                        {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
                      </button>
                    ) : (
                      <span>{member.role.charAt(0) + member.role.slice(1).toLowerCase()}</span>
                    )}
                  </td>
                  {canManageMembers && (
                    <td className="px-4 py-2">
                      {(member.user_id !== session?.user?.id || !isLastAdmin) && (
                        <DeleteIconButton
                          onClick={() => removeMemberMutation.mutate(member.user_id)}
                          disabled={removeMemberMutation.isPending}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
