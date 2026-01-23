'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { getApiKeys, createApiKey, deleteApiKey, type ApiKey } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime } from '@/lib/utils'
import { Plus, Trash2, Copy, Check, Key } from 'lucide-react'

export default function SettingsPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const queryClient = useQueryClient()

  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: () => getApiKeys(projectId),
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => createApiKey(projectId, name || undefined),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] })
      setNewKey(response.data.key)
      setNewKeyName('')
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

  const handleCopy = async () => {
    if (newKey) {
      await navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleCloseNewKey = () => {
    setNewKey(null)
    setShowCreate(false)
  }

  const apiKeys = data?.data || []

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Settings</h2>
        <p className="text-muted-foreground">
          Manage your project settings and API keys
        </p>
      </div>

      {/* API Keys Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Key className="h-5 w-5" />
                API Keys
              </CardTitle>
              <CardDescription>
                Use these keys to authenticate with the Traceroot SDK
              </CardDescription>
            </div>
            {!showCreate && !newKey && (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Create Key
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* New key display */}
          {newKey && (
            <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950">
              <p className="mb-2 text-sm font-medium text-green-800 dark:text-green-200">
                New API key created! Copy it now - you won&apos;t see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-white p-2 text-sm dark:bg-black">
                  {newKey}
                </code>
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  {copied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={handleCloseNewKey}
              >
                I&apos;ve copied the key
              </Button>
            </div>
          )}

          {/* Create key form */}
          {showCreate && !newKey && (
            <div className="mb-6 flex gap-4">
              <Input
                placeholder="Key name (optional)"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          )}

          {/* Keys list */}
          {isLoading ? (
            <p className="text-muted-foreground">Loading API keys...</p>
          ) : apiKeys.length === 0 ? (
            <p className="text-muted-foreground">
              No API keys yet. Create one to start using the SDK.
            </p>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((key: ApiKey) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-medium">
                        {key.key_prefix}...
                      </code>
                      {key.name && (
                        <Badge variant="secondary">{key.name}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Created {formatRelativeTime(key.created_at)}
                      {key.last_used_at && (
                        <> • Last used {formatRelativeTime(key.last_used_at)}</>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteMutation.mutate(key.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
