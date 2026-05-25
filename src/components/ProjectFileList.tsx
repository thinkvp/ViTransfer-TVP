'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'
import { Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'

interface ProjectFile {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
  uploadedByName: string | null
  sourceType?: 'projectFile' | 'emailAttachment'
  downloadUrl?: string
  deleteUrl?: string | null
}

interface ProjectFileListProps {
  projectId: string
  refreshTrigger?: number
  canDelete?: boolean
  onFilesChanged?: () => void
}

export function ProjectFileList({ projectId, refreshTrigger, canDelete = true, onFilesChanged }: ProjectFileListProps) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pendingDeleteFile, setPendingDeleteFile] = useState<ProjectFile | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/projects/${projectId}/files`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to fetch files')
      }
      const data = await res.json()
      setFiles(data.files || [])
    } catch (e: any) {
      setError(e?.message || 'Failed to load files')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshTrigger])

  const handleDownload = async (file: ProjectFile) => {
    try {
      const downloadEndpoint = file.downloadUrl || `/api/projects/${projectId}/files/${file.id}`
      const res = await apiFetch(downloadEndpoint)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to download file')
      }

      // If the route redirected to an external S3/R2 presigned URL, navigate there
      // directly so the browser uses its native download manager (with progress bar).
      const isS3Redirect = res.url && !res.url.startsWith(window.location.origin) && !res.url.startsWith('/')
      if (isS3Redirect) {
        void res.body?.cancel()
        const a = document.createElement('a')
        a.href = res.url
        document.body.appendChild(a)
        a.click()
        a.remove()
        return
      }

      // Local storage fallback: buffer via blob.
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = file.fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(blobUrl)
    } catch (e: any) {
      toast.error(e?.message || 'Failed to download file')
    }
  }

  const handleDelete = (file: ProjectFile) => {
    if (!file.deleteUrl) return
    setPendingDeleteFile(file)
  }

  const confirmDelete = async () => {
    const file = pendingDeleteFile
    if (!file?.deleteUrl) return
    setPendingDeleteFile(null)
    setDeletingId(file.id)
    try {
      await apiDelete(file.deleteUrl)
      setFiles((prev) => prev.filter((f) => f.id !== file.id))
      onFilesChanged?.()
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete file')
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-2">Loading files...</div>
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  if (files.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
        No files uploaded yet.
      </div>
    )
  }

  return (
    <>
    <div className="space-y-2">
      {files.map((f) => (
        <div key={f.id} className="flex items-center justify-between gap-3 border rounded-lg bg-card px-3 py-2">
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => void handleDownload(f)}
              className="w-full text-sm font-medium truncate text-left text-foreground hover:underline"
              title={`Download ${f.fileName}`}
            >
              {f.fileName}
            </button>
            <div className="text-xs text-muted-foreground truncate">
              {formatFileSize(Number(f.fileSize))}
              {f.uploadedByName ? ` • Uploaded by ${f.uploadedByName}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canDelete && !!f.deleteUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deletingId === f.id}
                onClick={() => void handleDelete(f)}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>

    <ConfirmDialog
      open={pendingDeleteFile !== null}
      onOpenChange={(v) => { if (!v) setPendingDeleteFile(null) }}
      title={`Delete "${pendingDeleteFile?.fileName ?? 'file'}"?`}
      description="This file will be permanently deleted."
      confirmLabel="Delete"
      onConfirm={confirmDelete}
    />
  </>
  )
}
