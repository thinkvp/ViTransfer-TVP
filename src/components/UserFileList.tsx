'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'
import { Download, Trash2 } from 'lucide-react'

interface UserFile {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
  uploadedByName: string | null
}

interface UserFileListProps {
  userId: string
  refreshTrigger?: number
}

export function UserFileList({ userId, refreshTrigger }: UserFileListProps) {
  const [files, setFiles] = useState<UserFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/users/${userId}/files`)
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
  }, [userId, refreshTrigger])

  const handleDownload = async (fileId: string, fileName: string) => {
    try {
      const res = await apiFetch(`/api/users/${userId}/files/${fileId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to download file')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)

      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()

      URL.revokeObjectURL(url)
    } catch (e: any) {
      alert(e?.message || 'Failed to download file')
    }
  }

  const handleDelete = async (fileId: string, fileName: string) => {
    if (!confirm(`Delete file "${fileName}"?`)) return

    setDeletingId(fileId)
    try {
      await apiDelete(`/api/users/${userId}/files/${fileId}`)
      setFiles((prev) => prev.filter((file) => file.id !== fileId))
    } catch (e: any) {
      alert(e?.message || 'Failed to delete file')
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
    return <div className="text-sm text-muted-foreground py-10 text-center">No files uploaded yet.</div>
  }

  return (
    <div className="space-y-2">
      {files.map((file) => (
        <div key={file.id} className="flex items-center justify-between gap-3 border rounded-lg bg-card px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{file.fileName}</div>
            <div className="text-xs text-muted-foreground truncate">
              {formatFileSize(Number(file.fileSize))}{file.uploadedByName ? ` • Uploaded by ${file.uploadedByName}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleDownload(file.id, file.fileName)}>
              <Download className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deletingId === file.id}
              onClick={() => void handleDelete(file.id, file.fileName)}
            >
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
