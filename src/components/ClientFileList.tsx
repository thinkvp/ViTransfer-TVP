'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiDelete, apiFetch } from '@/lib/api-client'
import { formatFileSize } from '@/lib/utils'
import { Download, Trash2 } from 'lucide-react'

interface ClientFile {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
  uploadedByName: string | null
}

interface ClientFileListProps {
  clientId: string
  refreshTrigger?: number
}

export function ClientFileList({ clientId, refreshTrigger }: ClientFileListProps) {
  const [files, setFiles] = useState<ClientFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/clients/${clientId}/files`)
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
  }, [clientId, refreshTrigger])

  const handleDownload = async (fileId: string, fileName: string) => {
    try {
      const res = await apiFetch(`/api/clients/${clientId}/files/${fileId}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || 'Failed to download file')
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)

      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()

      URL.revokeObjectURL(url)
    } catch (e: any) {
      alert(e?.message || 'Failed to download file')
    }
  }

  const handleDelete = async (fileId: string, fileName: string) => {
    if (!confirm(`Delete file "${fileName}"?`)) return

    setDeletingId(fileId)
    try {
      await apiDelete(`/api/clients/${clientId}/files/${fileId}`)
      setFiles((prev) => prev.filter((f) => f.id !== fileId))
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
      {files.map((f) => (
        <div key={f.id} className="flex items-center justify-between gap-3 border rounded-lg bg-card px-3 py-2">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{f.fileName}</div>
            <div className="text-xs text-muted-foreground truncate">
              {formatFileSize(Number(f.fileSize))}{f.uploadedByName ? ` • Uploaded by ${f.uploadedByName}` : ''}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleDownload(f.id, f.fileName)}>
              <Download className="w-4 h-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={deletingId === f.id}
              onClick={() => void handleDelete(f.id, f.fileName)}
            >
              <Trash2 className="w-4 h-4 text-destructive" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
