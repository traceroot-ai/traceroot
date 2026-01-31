"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  getOrganization,
  updateOrganization,
  deleteOrganization,
  getMembers,
  addMember,
  updateMemberRole,
  removeMember,
  type Member,
  type Role,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLayout } from "@/components/layout/app-layout";
import { cn } from "@/lib/utils";
import {
  Plus,
  Trash2,
  SlidersHorizontal,
  Users,
  ChevronLeft,
} from "lucide-react";
import Link from "next/link";

// Tab definitions
const settingsTabs = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "members", label: "Members", icon: Users },
] as const;

type TabId = (typeof settingsTabs)[number]["id"];

export default function OrgSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = params.orgId as string;
  const { setHeaderContent } = useLayout();

  // Get initial tab from URL or default to "general"
  const initialTab = (searchParams.get("tab") as TabId) || "general";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  // Get organization details
  const { data: org } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
  });

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <div className="flex items-center gap-2">
        <Link
          href="/organizations"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Organizations
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          href={`/organizations/${orgId}/projects`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {org?.name || "..."}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">Settings</span>
      </div>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, org?.name, orgId]);

  return (
    <div className="flex h-full">
      {/* Left sidebar navigation */}
      <nav className="w-36 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors",
                    activeTab === tab.id
                      ? "bg-muted"
                      : "hover:bg-muted/50"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-6">
        <div>
          {activeTab === "general" && <GeneralTab orgId={orgId} />}
          {activeTab === "members" && <MembersTab orgId={orgId} />}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// General Tab
// =============================================================================

function GeneralTab({ orgId }: { orgId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: org, isLoading } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    if (org) {
      setOrgName(org.name);
    }
  }, [org]);

  const updateMutation = useMutation({
    mutationFn: (name: string) => updateOrganization(orgId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteOrganization(orgId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      router.push("/organizations");
    },
  });

  const handleSave = () => {
    if (orgName.trim() && orgName !== org?.name) {
      updateMutation.mutate(orgName.trim());
    }
  };

  const handleDelete = () => {
    if (deleteConfirmText === org?.name) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading organization...</div>;
  }

  const isOwner = org?.role === "OWNER";

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">General</h2>
        <p className="text-sm text-muted-foreground">
          Manage your organization settings
        </p>
      </div>

      {/* Rename Organization Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Rename organization</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Update the name of your organization. Changes will take effect immediately.
        </p>
        <div className="flex gap-2 mt-3">
          <Input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Organization name"
            className="max-w-xs h-8 text-sm"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateMutation.isPending || orgName === org?.name || !orgName.trim()}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Delete Organization Section - Only for owners */}
      {isOwner && (
        <div className="border p-4">
          <h3 className="text-sm font-medium">Delete organization</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Permanently delete this organization and all of its projects and data. This action cannot be undone.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDeleteDialog(true)}
            className="mt-3 border-destructive text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete organization
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Organization</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the organization
              &quot;<span className="font-semibold">{org?.name}</span>&quot; and all associated projects and data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-2">
              Type <span className="font-mono font-semibold text-foreground">{org?.name}</span> to confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Organization name"
            />
            {deleteMutation.isError && (
              <p className="mt-2 text-sm text-destructive">
                {deleteMutation.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConfirmText !== org?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Organization"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =============================================================================
// Members Tab
// =============================================================================

function MembersTab({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();

  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<Role>("MEMBER");
  const [editingMember, setEditingMember] = useState<{ userId: string; role: Role } | null>(null);

  // Get organization to check user's role
  const { data: org } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
  });

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => getMembers(orgId),
  });

  const addMemberMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) =>
      addMember(orgId, email, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
      setShowAddMember(false);
      setNewMemberEmail("");
      setNewMemberRole("MEMBER");
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      updateMemberRole(orgId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
      setEditingMember(null);
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
    },
  });

  const handleAddMember = () => {
    if (newMemberEmail.trim()) {
      addMemberMutation.mutate({ email: newMemberEmail.trim(), role: newMemberRole });
    }
  };

  const handleUpdateRole = () => {
    if (editingMember) {
      updateRoleMutation.mutate(editingMember);
    }
  };

  const roleOptions: Role[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
  const canManageMembers = org?.role === "OWNER" || org?.role === "ADMIN";

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            Manage organization members and their roles
          </p>
        </div>
        {canManageMembers && (
          <Button variant="outline" size="sm" onClick={() => setShowAddMember(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add member
          </Button>
        )}
      </div>

      {/* Add Member Dialog */}
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Member</DialogTitle>
            <DialogDescription>
              Invite a new member to this organization. They must have an existing account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Email</label>
              <Input
                placeholder="member@example.com"
                value={newMemberEmail}
                onChange={(e) => setNewMemberEmail(e.target.value)}
                type="email"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Role</label>
              <select
                value={newMemberRole}
                onChange={(e) => setNewMemberRole(e.target.value as Role)}
                className="flex h-9 w-full border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {role.charAt(0) + role.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            {addMemberMutation.isError && (
              <p className="text-sm text-destructive">
                {addMemberMutation.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMember(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddMember}
              disabled={!newMemberEmail.trim() || addMemberMutation.isPending}
            >
              {addMemberMutation.isPending ? "Adding..." : "Add Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>
              Update the member&apos;s role in this organization.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium mb-2 block">Role</label>
            <select
              value={editingMember?.role || "MEMBER"}
              onChange={(e) =>
                setEditingMember(
                  editingMember ? { ...editingMember, role: e.target.value as Role } : null
                )
              }
              className="flex h-9 w-full border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {role.charAt(0) + role.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMember(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdateRole} disabled={updateRoleMutation.isPending}>
              {updateRoleMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Members Table */}
      <div className="border">
        {isLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No members found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted/30">
                <th className="px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Role</th>
                {canManageMembers && (
                  <th className="px-4 py-3 font-medium text-muted-foreground w-20"></th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member: Member) => (
                <tr key={member.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    {member.name || <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{member.email || "-"}</td>
                  <td className="px-4 py-3">
                    {canManageMembers && member.role !== "OWNER" ? (
                      <button
                        onClick={() => setEditingMember({ userId: member.user_id, role: member.role })}
                        className="hover:underline cursor-pointer"
                      >
                        {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
                      </button>
                    ) : (
                      <span>{member.role.charAt(0) + member.role.slice(1).toLowerCase()}</span>
                    )}
                  </td>
                  {canManageMembers && (
                    <td className="px-4 py-3">
                      {member.role !== "OWNER" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => removeMemberMutation.mutate(member.user_id)}
                          disabled={removeMemberMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
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
