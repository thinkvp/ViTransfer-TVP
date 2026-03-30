'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'

type AttachmentFile = {
  id: string
  fileName: string
  fileSize: string
  uploadedByName?: string | null
  downloadUrl: string
}

interface ProjectReadonlyAttachmentListProps {
  projectId: string
  endpoint: string
  refreshTrigger?: number
  emptyText?: string
  showUploadedBy?: boolean
}

export function ProjectReadonlyAttachmentList({
  projectId,
  endpoint,
  refreshTrigger,
  emptyText = 'No attachments found.',
  showUploadedBy = false,
}: ProjectReadonlyAttachmentListProps) {
  const [files, setFiles] = useState<AttachmentFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await apiFetch(endpoint)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data?.error || 'Failed to fetch attachments')
        }

        const data = await res.json()
        if (!cancelled) {
          setFiles(Array.isArray(data?.files) ? data.files : [])
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Failed to load attachments')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [endpoint, projectId, refreshTrigger])

  const handleDownload = async (file: AttachmentFile) => {
    try {
      const res = await apiFetch(file.downloadUrl)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to download attachment')
      }

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
      alert(e?.message || 'Failed to download attachment')
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-2">Loading attachments...</div>
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>
  }

  if (files.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
        {emptyText}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <div key={file.id} className="flex items-center justify-between gap-3 border rounded-lg bg-card px-3 py-2">
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => void handleDownload(file)}
              className="w-full text-sm font-medium truncate text-left text-foreground hover:underline"
              title={`Download ${file.fileName}`}
            >
              {file.fileName}
            </button>
            <div className="text-xs text-muted-foreground truncate">
              {formatFileSize(Number(file.fileSize))}
              {showUploadedBy && file.uploadedByName ? ` • Uploaded by ${file.uploadedByName}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}