"use client";

import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";
import { useId, useState } from "react";
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
  const formId = useId();
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
  const t = useT();
  const roleLabels: Record<string, string> = {
    [Role.ADMIN]: t("members.roleAdmin"),
    [Role.MEMBER]: t("members.roleMember"),
    [Role.VIEWER]: t("members.roleViewer"),
  };
  // A role this build does not know keeps the capitalised name it had before.
  const roleLabel = (role: string) =>
    roleLabels[role] ?? role.charAt(0) + role.slice(1).toLowerCase();
  const canManageMembers = workspace?.role === Role.ADMIN;
  const adminCount = members.filter((m: Member) => m.role === Role.ADMIN).length;
  const isLastAdmin = workspace?.role === Role.ADMIN && adminCount <= 1;

  return (
    <div className="space-y-6">
      <div className="-mx-4 -mt-4 flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-[15px] font-medium">{t("members.title")}</h2>
          <p className="text-[13px] text-muted-foreground">{t("members.subtitle")}</p>
        </div>
        {canManageMembers && (
          <AddButton
            onClick={() => {
              if (inviteMutation.isError) inviteMutation.reset();
              setShowInviteMember(true);
            }}
          >
            {t("members.invite")}
          </AddButton>
        )}
      </div>

      <Dialog open={showInviteMember} onOpenChange={setShowInviteMember}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("members.inviteTitle")}</DialogTitle>
            <DialogDescription>{t("members.inviteDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label htmlFor={`${formId}-invite-email`} className="mb-2 block text-sm font-medium">
                {t("members.email")}
              </label>
              <Input
                placeholder="member@example.com"
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                id={`${formId}-invite-email`}
                type="email"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-invite-role`} className="mb-2 block text-sm font-medium">
                {t("members.role")}
              </label>
              <Select
                value={newMemberRole}
                onValueChange={(value) => setNewMemberRole(value as Role)}
              >
                <SelectTrigger id={`${formId}-invite-role`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabel(role)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {inviteMutation.isError && (
              <p role="alert" className="text-sm text-destructive">
                {translateClientError(t, inviteMutation.error.message)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowInviteMember(false)}
              disabled={inviteMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleInviteMember}
              disabled={!newMemberEmail.trim() || inviteMutation.isPending}
            >
              {inviteMutation.isPending ? t("members.sending") : t("members.sendInvitation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("members.changeRoleTitle")}</DialogTitle>
            <DialogDescription>{t("members.changeRoleDescription")}</DialogDescription>
          </DialogHeader>
          <div>
            <label htmlFor={`${formId}-member-role`} className="mb-2 block text-sm font-medium">
              {t("members.role")}
            </label>
            <Select
              value={editingMember?.role || Role.MEMBER}
              onValueChange={(value) =>
                setEditingMember(editingMember ? { ...editingMember, role: value as Role } : null)
              }
            >
              <SelectTrigger id={`${formId}-member-role`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((role) => (
                  <SelectItem key={role} value={role}>
                    {roleLabel(role)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {updateRoleMutation.isError && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {translateClientError(t, updateRoleMutation.error.message)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditingMember(null)}
              disabled={updateRoleMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={handleUpdateRole} disabled={updateRoleMutation.isPending}>
              {updateRoleMutation.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!invitesLoading && invites.length > 0 && (
        <div className="border">
          <div className="flex h-9 items-center border-b border-border px-4">
            <h3 className="text-[13px] font-medium">{t("members.pendingTitle")}</h3>
          </div>
          <table className="data-table w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">
                  {t("members.email")}
                </th>
                <th className="px-4 py-2 font-medium text-muted-foreground">{t("members.role")}</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">
                  {t("members.invitedBy")}
                </th>
                {canManageMembers && (
                  <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {invites.map((invite: Invite) => (
                <tr key={invite.id} className="border-b last:border-b-0 hover:bg-muted">
                  <td className="px-4 py-2">{invite.email}</td>
                  <td className="px-4 py-2">{roleLabel(invite.role)}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {invite.invited_by?.name || invite.invited_by?.email || "-"}
                  </td>
                  {canManageMembers && (
                    <td className="px-4 py-2">
                      <DeleteIconButton
                        aria-label={t("members.cancelInvitationFor", { email: invite.email })}
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
        <div className="flex h-9 items-center border-b border-border px-4">
          <h3 className="text-[13px] font-medium">{t("members.title")}</h3>
        </div>
        {membersLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">{t("members.loading")}</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">{t("members.empty")}</div>
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr className="border-b text-left">
                <th className="px-4 py-2 font-medium text-muted-foreground">{t("common.name")}</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">
                  {t("members.email")}
                </th>
                <th className="px-4 py-2 font-medium text-muted-foreground">{t("members.role")}</th>
                {canManageMembers && (
                  <th className="w-20 px-4 py-2 font-medium text-muted-foreground"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member: Member) => (
                <tr key={member.id} className="border-b last:border-b-0 hover:bg-muted">
                  <td className="px-4 py-2">
                    {member.name || <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{member.email || "-"}</td>
                  <td className="px-4 py-2">
                    {canManageMembers ? (
                      <button
                        onClick={() => {
                          if (updateRoleMutation.isError) updateRoleMutation.reset();
                          setEditingMember({ userId: member.user_id, role: member.role });
                        }}
                        className="cursor-pointer hover:underline"
                      >
                        {roleLabel(member.role)}
                      </button>
                    ) : (
                      <span>{roleLabel(member.role)}</span>
                    )}
                  </td>
                  {canManageMembers && (
                    <td className="px-4 py-2">
                      {(member.user_id !== session?.user?.id || !isLastAdmin) && (
                        <DeleteIconButton
                          aria-label={t("members.removeMember", {
                            name: member.name || member.email || "",
                          })}
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
