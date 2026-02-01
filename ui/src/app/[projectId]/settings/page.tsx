'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import {
  getAccessKeys,
  createAccessKey,
  updateAccessKey,
  deleteAccessKey,
  getProject,
  updateProject,
  deleteProject,
  type AccessKey,
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
  Info,
} from 'lucide-react'

// Tab definitions
const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'api-keys', label: 'API Keys', icon: Key },
] as const

type TabId = (typeof settingsTabs)[number]['id']

// Helper to format key hint for display: "tr-d0a3...ee92"
function formatKeyHint(keyHint: string): string {
  // keyHint is like "tr-d0a3ee92" - we want "tr-d0a3...ee92"
  if (keyHint.startsWith('tr-')) {
    const rest = keyHint.slice(3) // remove "tr-"
    if (rest.length > 8) {
      return `tr-${rest.slice(0, 4)}...${rest.slice(-4)}`
    }
    return keyHint
  }
  return keyHint
}

export default function SettingsPage() {
  const params = useParams()
  const projectId = params.projectId as string

  const [activeTab, setActiveTab] = useState<TabId>('general')

  return (
    <div className="flex h-full">
      {/* Left sidebar navigation */}
      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors',
                    activeTab === tab.id
                      ? 'bg-muted'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-4">
        <div>
          {activeTab === 'general' && <GeneralTab projectId={projectId} />}
          {activeTab === 'api-keys' && <AccessKeysTab projectId={projectId} />}
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
    mutationFn: (name: string) => {
      if (!project) throw new Error('Project not found')
      return updateProject(project.workspace_id, projectId, { name })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!project) throw new Error('Project not found')
      return deleteProject(project.workspace_id, projectId)
    },
    onSuccess: () => {
      // Invalidate all related queries before navigating
      const workspaceId = project?.workspace_id
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] })
      queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] })
      router.push(`/workspaces/${workspaceId}/projects`)
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
    return <div className="text-[13px] text-muted-foreground">Loading project...</div>
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">General</h2>
        <p className="text-[13px] text-muted-foreground">
          Manage your project settings and preferences
        </p>
      </div>

      {/* Rename Project Section */}
      <div className="border p-4">
        <h3 className="text-[13px] font-medium">Rename project</h3>
        <p className="text-[12px] text-muted-foreground mt-1">
          Update the name of your project. Changes will take effect immediately.
        </p>
        <div className="flex gap-2 mt-3">
          <Input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Project name"
            className="max-w-xs h-7 text-[13px]"
          />
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleSave}
            disabled={updateMutation.isPending || projectName === project?.name || !projectName.trim()}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Delete Project Section */}
      <div className="border p-4">
        <h3 className="text-[13px] font-medium">Delete project</h3>
        <p className="text-[12px] text-muted-foreground mt-1">
          Permanently delete this project and all of its data. This action cannot be undone.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowDeleteDialog(true)}
          className="mt-3 h-7 text-[12px] border-destructive text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="mr-1.5 h-3 w-3" />
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
// Access Keys Tab
// =============================================================================

function AccessKeysTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyData, setNewKeyData] = useState<{ key: string; keyHint: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<{ id: string; name: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['access-keys', projectId],
    queryFn: () => getAccessKeys(projectId),
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => createAccessKey(projectId, name || undefined),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['access-keys', projectId] })
      setNewKeyData({ key: response.data.key, keyHint: response.data.key_hint })
      setNewKeyName('')
      setShowCreateDialog(false)
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string | null }) =>
      updateAccessKey(projectId, keyId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access-keys', projectId] })
      setEditingKey(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (keyId: string) => deleteAccessKey(projectId, keyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['access-keys', projectId] })
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

  const accessKeys = data?.access_keys || []

  // Generate the .env block content
  const envBlockContent = newKeyData
    ? `TRACEROOT_API_KEY = "${newKeyData.key}"`
    : accessKeys.length > 0
    ? `TRACEROOT_API_KEY = "${formatKeyHint(accessKeys[0].key_hint)}"`
    : `TRACEROOT_API_KEY = "tr-..."`

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h2 className="text-lg font-semibold">Project API Keys</h2>
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={() => setShowCreateDialog(true)}>
          <Plus className="mr-1 h-3 w-3" />
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
          <div className="px-3 py-3 text-[13px] text-muted-foreground">Loading API keys...</div>
        ) : accessKeys.length === 0 ? (
          <div className="px-3 py-3 text-[13px] text-muted-foreground">
            No API keys yet. Create one to start using the SDK.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b text-left bg-muted/30">
                <th className="px-3 py-2 font-medium text-[12px] text-muted-foreground">Name</th>
                <th className="px-3 py-2 font-medium text-[12px] text-muted-foreground">Key</th>
                <th className="px-3 py-2 font-medium text-[12px] text-muted-foreground">Created</th>
                <th className="px-3 py-2 font-medium text-[12px] text-muted-foreground">Last Used</th>
                <th className="px-3 py-2 font-medium text-[12px] text-muted-foreground w-10"></th>
              </tr>
            </thead>
            <tbody>
              {accessKeys.map((key: AccessKey) => (
                <tr key={key.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setEditingKey({ id: key.id, name: key.name || '' })}
                      className="hover:underline text-left cursor-pointer"
                    >
                      {key.name || <span className="text-muted-foreground">-</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5">{formatKeyHint(key.key_hint)}</code>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatRelativeTime(key.create_time)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {key.last_use_time ? formatRelativeTime(key.last_use_time) : 'Never'}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => deleteMutation.mutate(key.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
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
