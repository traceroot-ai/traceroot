'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import {
  getApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  getProject,
  updateProject,
  deleteProject,
  getMembers,
  addMember,
  removeMember,
  type ApiKey,
  type Member,
  type Role,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import {
  Plus,
  Trash2,
  Copy,
  Check,
  Key,
  SlidersHorizontal,
  Users,
  Info,
} from 'lucide-react'

// Tab definitions
const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'members', label: 'Members', icon: Users },
] as const

type TabId = (typeof settingsTabs)[number]['id']

// Helper to format key prefix: show first 4 and last 4 chars after "tr-"
function formatKeyPrefix(keyPrefix: string): string {
  // keyPrefix is like "tr-d0a3ee9" - we want "tr-d0a3...ee9"
  if (keyPrefix.startsWith('tr-')) {
    const rest = keyPrefix.slice(3) // remove "tr-"
    if (rest.length > 4) {
      return `tr-${rest.slice(0, 4)}...${rest.slice(-4)}`
    }
    return keyPrefix
  }
  return keyPrefix
}

export default function SettingsPage() {
  const params = useParams()
  const projectId = params.projectId as string

  const [activeTab, setActiveTab] = useState<TabId>('general')

  return (
    <div className="flex h-full">
      {/* Left sidebar navigation */}
      <nav className="w-36 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors',
                    activeTab === tab.id
                      ? 'bg-muted font-medium'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-6">
        <div>
          {activeTab === 'general' && <GeneralTab projectId={projectId} />}
          {activeTab === 'api-keys' && <ApiKeysTab projectId={projectId} />}
          {activeTab === 'members' && <MembersTab projectId={projectId} />}
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// General Tab
// =============================================================================

function GeneralTab({ projectId }: { projectId: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  useEffect(() => {
    if (project) {
      setProjectName(project.name)
    }
  }, [project])

  const updateMutation = useMutation({
    mutationFn: (name: string) => updateProject(projectId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!project) throw new Error('Project not found')
      return deleteProject(project.org_id, projectId)
    },
    onSuccess: () => {
      router.push('/organizations')
    },
  })

  const handleSave = () => {
    if (projectName.trim() && projectName !== project?.name) {
      updateMutation.mutate(projectName.trim())
    }
  }

  const handleDelete = () => {
    if (deleteConfirmText === project?.name) {
      deleteMutation.mutate()
    }
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading project...</div>
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold">General</h2>
        <p className="text-sm text-muted-foreground">
          Manage your project settings and preferences
        </p>
      </div>

      {/* Rename Project Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Rename project</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Update the name of your project. Changes will take effect immediately.
        </p>
        <div className="flex gap-2 mt-3">
          <Input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Project name"
            className="max-w-xs h-8 text-sm"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={updateMutation.isPending || projectName === project?.name || !projectName.trim()}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Delete Project Section */}
      <div className="border p-4">
        <h3 className="text-sm font-medium">Delete project</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Permanently delete this project and all of its data. This action cannot be undone.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDeleteDialog(true)}
          className="mt-3 border-destructive text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete project
        </Button>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the project
              &quot;<span className="font-semibold">{project?.name}</span>&quot; and all associated data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-2">
              Type <span className="font-mono font-semibold text-foreground">{project?.name}</span> to confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Project name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConfirmText !== project?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// =============================================================================
// API Keys Tab
// =============================================================================

function ApiKeysTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyData, setNewKeyData] = useState<{ key: string; keyPrefix: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<{ id: string; name: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: () => getApiKeys(projectId),
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => createApiKey(projectId, name || undefined),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] })
      setNewKeyData({ key: response.data.key, keyPrefix: response.data.key_prefix })
      setNewKeyName('')
      setShowCreateDialog(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string | null }) =>
      updateApiKey(projectId, keyId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] })
      setEditingKey(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteApiKey(projectId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] })
    },
  })

  const handleCreate = () => {
    createMutation.mutate(newKeyName)
  }

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleCloseNewKey = () => {
    setNewKeyData(null)
  }

  const handleSaveNote = () => {
    if (editingKey) {
      updateMutation.mutate({ keyId: editingKey.id, name: editingKey.name || null })
    }
  }

  const apiKeys = data?.data || []

  // Generate the .env block content
  const envBlockContent = newKeyData
    ? `TRACEROOT_API_KEY = "${newKeyData.key}"`
    : apiKeys.length > 0
    ? `TRACEROOT_API_KEY = "${formatKeyPrefix(apiKeys[0].key_prefix)}"`
    : `TRACEROOT_API_KEY = "tr-..."`

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xl font-semibold">Project API Keys</h2>
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Create new API key
        </Button>
      </div>

      {/* .env format code block */}
      <div className="border">
        <div className="flex items-center justify-between px-4 py-2 border-b">
          <span className="text-xs text-muted-foreground">.env</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => handleCopy(envBlockContent, 'env-block')}
          >
            {copied === 'env-block' ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <div className="bg-muted px-4 py-3 font-mono text-xs">
          <pre className="whitespace-pre-wrap">{envBlockContent}</pre>
        </div>
      </div>

      {/* New key display */}
      {newKeyData && (
        <div className="border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950">
          <div className="px-4 py-3">
            <p className="mb-2 text-xs font-medium text-green-800 dark:text-green-200">
              New API key created! Copy it now - you won&apos;t see it again.
            </p>
            <div className="flex items-center gap-2 mb-2">
              <code className="flex-1 bg-white px-2 py-1.5 text-xs dark:bg-black font-mono border">
                {newKeyData.key}
              </code>
              <Button size="sm" variant="outline" className="h-7" onClick={() => handleCopy(newKeyData.key, 'new-key')}>
                {copied === 'new-key' ? (
                  <Check className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleCloseNewKey}>
              I&apos;ve copied the key
            </Button>
          </div>
        </div>
      )}

      {/* Create API Key Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Create a new API key to authenticate with the Traceroot SDK.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium mb-2 block">Name (optional)</label>
            <Input
              placeholder="e.g., Production, Development"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Note Dialog */}
      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Note</DialogTitle>
            <DialogDescription>
              Update the note for this API key.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g., Production, Development"
              value={editingKey?.name || ''}
              onChange={(e) => setEditingKey(editingKey ? { ...editingKey, name: e.target.value } : null)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveNote()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveNote} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Keys table */}
      <div className="border">
        {isLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading API keys...</div>
        ) : apiKeys.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            No API keys yet. Create one to start using the SDK.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left bg-muted/30">
                <th className="px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Key</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Created</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Last Used</th>
                <th className="px-4 py-3 font-medium text-muted-foreground w-10"></th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((key: ApiKey) => (
                <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setEditingKey({ id: key.id, name: key.name || '' })}
                      className="hover:underline text-left cursor-pointer"
                    >
                      {key.name || <span className="text-muted-foreground">-</span>}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs bg-muted px-1.5 py-0.5">{formatKeyPrefix(key.key_prefix)}</code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatRelativeTime(key.created_at)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {key.last_used_at ? formatRelativeTime(key.last_used_at) : 'Never'}
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => deleteMutation.mutate(key.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// Members Tab
// =============================================================================

function MembersTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()

  const [showAddMember, setShowAddMember] = useState(false)
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<Role>('MEMBER')

  // First get the project to get org_id
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  })

  const orgId = project?.org_id

  const { data: members = [], isLoading } = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => getMembers(orgId!),
    enabled: !!orgId,
  })

  const addMemberMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) =>
      addMember(orgId!, email, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', orgId] })
      setShowAddMember(false)
      setNewMemberEmail('')
      setNewMemberRole('MEMBER')
    },
  })

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId!, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', orgId] })
    },
  })

  const handleAddMember = () => {
    if (newMemberEmail.trim()) {
      addMemberMutation.mutate({ email: newMemberEmail.trim(), role: newMemberRole })
    }
  }

  const roleOptions: Role[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Project Members</h2>
        <Button variant="outline" size="sm" onClick={() => setShowAddMember(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add new member
        </Button>
      </div>

      {/* Add Member Dialog */}
      <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Member</DialogTitle>
            <DialogDescription>
              Invite a new member to this organization.
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddMember(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddMember}
              disabled={!newMemberEmail.trim() || addMemberMutation.isPending}
            >
              {addMemberMutation.isPending ? 'Adding...' : 'Add Member'}
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
                <th className="px-4 py-3 font-medium text-muted-foreground w-10"></th>
              </tr>
            </thead>
            <tbody>
              {members.map((member: Member) => (
                <tr key={member.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    {member.name || <span className="text-muted-foreground">-</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{member.email || '-'}</td>
                  <td className="px-4 py-3">
                    {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
                  </td>
                  <td className="px-4 py-3">
                    {member.role !== 'OWNER' && (
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
