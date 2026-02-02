"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  getMembers,
  updateMemberRole,
  removeMember,
  getInvites,
  createInvite,
  cancelInvite,
  type Member,
  type Invite,
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
  CreditCard,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

// Tab definitions
const settingsTabs = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "members", label: "Members", icon: Users },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

type TabId = (typeof settingsTabs)[number]["id"];

export default function WorkspaceSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = params.workspaceId as string;
  const { setHeaderContent } = useLayout();

  // Get initial tab from URL or default to "general"
  const initialTab = (searchParams.get("tab") as TabId) || "general";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  // Get workspace details
  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <div className="flex items-center gap-2">
        <Link
          href="/workspaces"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Workspaces
        </Link>
        <span className="text-muted-foreground">/</span>
        <Link
          href={`/workspaces/${workspaceId}/projects`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {workspace?.name || "..."}
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium">Settings</span>
      </div>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, workspace?.name, workspaceId]);

  return (
    <div className="flex h-full">
      {/* Left sidebar navigation */}
      <nav className="w-40 border-r">
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
          {activeTab === "general" && <GeneralTab workspaceId={workspaceId} />}
          {activeTab === "members" && <MembersTab workspaceId={workspaceId} />}
          {activeTab === "billing" && <BillingTab workspaceId={workspaceId} />}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// General Tab
// =============================================================================

function GeneralTab({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  });

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name);
    }
  }, [workspace]);

  const updateMutation = useMutation({
    mutationFn: (name: string) => updateWorkspace(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteWorkspace(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      router.push("/workspaces");
    },
  });

  const handleSave = () => {
    if (workspaceName.trim() && workspaceName !== workspace?.name) {
      updateMutation.mutate(workspaceName.trim());
    }
  };

  const handleDelete = () => {
    if (deleteConfirmText === workspace?.name) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  const isOwner = workspace?.role === "OWNER";

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">General</h2>
        <p className="text-sm text-muted-foreground">
          Manage your workspace settings
        </p>
      </div>

      {/* Rename Workspace Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Rename workspace</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Update the name of your workspace. Changes will take effect immediately.
        </p>
        <div className="flex gap-2 mt-3">
          <Input
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="Workspace name"
            className="max-w-xs h-8 text-sm"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateMutation.isPending || workspaceName === workspace?.name || !workspaceName.trim()}
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {/* Delete Workspace Section - Only for owners */}
      {isOwner && (
        <div className="border p-4">
          <h3 className="text-sm font-medium">Delete workspace</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Permanently delete this workspace and all of its projects and data. This action cannot be undone.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDeleteDialog(true)}
            className="mt-3 border-destructive text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete workspace
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Workspace</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the workspace
              &quot;<span className="font-semibold">{workspace?.name}</span>&quot; and all associated projects and data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-2">
              Type <span className="font-mono font-semibold text-foreground">{workspace?.name}</span> to confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Workspace name"
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
              disabled={deleteConfirmText !== workspace?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Workspace"}
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

function MembersTab({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();

  const [showInviteMember, setShowInviteMember] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<Role>("MEMBER");
  const [editingMember, setEditingMember] = useState<{ userId: string; role: Role } | null>(null);

  // Get workspace to check user's role
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
      setNewMemberRole("MEMBER");
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

  const roleOptions: Role[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
  const canManageMembers = workspace?.role === "OWNER" || workspace?.role === "ADMIN";

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Members</h2>
          <p className="text-sm text-muted-foreground">
            Manage workspace members and invitations
          </p>
        </div>
        {canManageMembers && (
          <Button variant="outline" size="sm" onClick={() => setShowInviteMember(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Invite member
          </Button>
        )}
      </div>

      {/* Invite Member Dialog */}
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
                {roleOptions.filter(r => r !== "OWNER").map((role) => (
                  <option key={role} value={role}>
                    {role.charAt(0) + role.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            {inviteMutation.isError && (
              <p className="text-sm text-destructive">
                {inviteMutation.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteMember(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleInviteMember}
              disabled={!newMemberEmail.trim() || inviteMutation.isPending}
            >
              {inviteMutation.isPending ? "Sending..." : "Send Invitation"}
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
              Update the member&apos;s role in this workspace.
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

      {/* Pending Invitations */}
      {!invitesLoading && invites.length > 0 && (
        <div className="border">
          <div className="px-4 py-3 bg-muted/30 border-b">
            <h3 className="text-sm font-medium">Pending Invitations</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted/10">
                <th className="px-4 py-2 font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Role</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Invited By</th>
                {canManageMembers && (
                  <th className="px-4 py-2 font-medium text-muted-foreground w-20"></th>
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
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => cancelInviteMutation.mutate(invite.id)}
                        disabled={cancelInviteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Members Table */}
      <div className="border">
        <div className="px-4 py-3 bg-muted/30 border-b">
          <h3 className="text-sm font-medium">Members</h3>
        </div>
        {membersLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading members...</div>
        ) : members.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No members found.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted/10">
                <th className="px-4 py-2 font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Email</th>
                <th className="px-4 py-2 font-medium text-muted-foreground">Role</th>
                {canManageMembers && (
                  <th className="px-4 py-2 font-medium text-muted-foreground w-20"></th>
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
                    <td className="px-4 py-2">
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

// =============================================================================
// Billing Tab
// =============================================================================

const pricingPlans = [
  {
    id: "free",
    name: "Free",
    description: "Get started with basic features",
    price: 0,
    features: [
      "1 seat only",
      "10k trace + logs",
      "100k LLM tokens",
      "7d retention",
      "AI agent with chat mode only",
    ],
    buttonText: "Current Plan",
    highlighted: false,
    disabled: true,
  },
  {
    id: "starter",
    name: "Starter",
    description: "For individuals and small teams",
    price: 49,
    features: [
      "Up to 1 workspace",
      "Up to 5 seats",
      "100k trace + logs",
      "1M LLM tokens",
      "30d retention",
      "Source code visible in UI",
      "AI agent with chat mode only",
    ],
    buttonText: "Upgrade",
    highlighted: false,
  },
  {
    id: "pro",
    name: "Pro",
    description: "For all your extra messaging needs",
    price: 99,
    features: [
      "Everything in Starter",
      "Up to 1 workspace",
      "Unlimited users",
      "AI agent has chat + agent mode",
      "Optional full codebase access (GitHub integration)",
      "AI Agent auto-triaging production issues",
    ],
    buttonText: "Upgrade",
    highlighted: true,
    badge: "Popular",
  },
  {
    id: "startups",
    name: "Startups",
    description: "For those of you who are really serious",
    price: 999,
    features: [
      "Everything in Pro",
      "Up to 5 workspaces",
      "5M trace + logs",
      "50M LLM tokens",
      "Slack & Notion integration, full GitHub support with ticket/PR context",
      "SOC2 & ISO27001 reports, BAA available (HIPAA)",
    ],
    buttonText: "Upgrade",
    highlighted: false,
  },
];

function BillingTab({ workspaceId: _workspaceId }: { workspaceId: string }) {
  const [showPricingDialog, setShowPricingDialog] = useState(false);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">Billing</h2>
        <p className="text-sm text-muted-foreground">
          Manage your subscription and billing details
        </p>
      </div>

      {/* Current Plan Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Current plan</h3>
        <p className="text-sm text-muted-foreground mt-1">
          You are currently on the <span className="font-medium text-foreground">Free</span> plan.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowPricingDialog(true)}
          className="mt-3"
        >
          Change plan
        </Button>
      </div>

      {/* Usage Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Usage</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Your usage statistics for the current billing period.
        </p>
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Traces</span>
            <span>0 / 1,000</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">LLM tokens</span>
            <span>0 / 100,000</span>
          </div>
        </div>
      </div>

      {/* Pricing Dialog */}
      <Dialog open={showPricingDialog} onOpenChange={setShowPricingDialog}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Choose a plan</DialogTitle>
            <DialogDescription>
              Select a plan that best fits your needs.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {pricingPlans.map((plan) => (
                <div
                  key={plan.id}
                  className={cn(
                    "border p-4 flex flex-col",
                    plan.highlighted && "border-foreground shadow-md"
                  )}
                >
                  {/* Plan header */}
                  <div className="border-b pb-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">{plan.name}</h3>
                      {plan.badge && (
                        <span className="text-xs px-2 py-1 bg-muted rounded-full">
                          {plan.badge}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                      {plan.description}
                    </p>
                  </div>

                  {/* Price */}
                  <div className="py-3 border-b">
                    <span className="text-2xl font-bold">${plan.price}</span>
                    <span className="text-muted-foreground"> per month</span>
                  </div>

                  {/* Features */}
                  <div className="py-3 flex-1">
                    <ul className="space-y-2">
                      {plan.features.map((feature, index) => (
                        <li key={index} className="text-sm">
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* CTA Button */}
                  <Button
                    variant={plan.highlighted ? "default" : "outline"}
                    className="w-full mt-4 justify-between"
                    disabled={plan.disabled}
                    onClick={() => {
                      // TODO: Implement plan selection
                      setShowPricingDialog(false);
                    }}
                  >
                    {plan.buttonText}
                    {!plan.disabled && <ArrowRight className="h-4 w-4" />}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
