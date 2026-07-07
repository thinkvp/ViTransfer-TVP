'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Pencil,
  X,
  Loader2,
  Upload,
  Folder,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileArchive,
  File as FileIcon,
} from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import { apiDelete, apiFetch, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InlineEdit } from '@/components/InlineEdit'
import { toast } from 'sonner'

type UploadFolder = {
  id: string
  relativePath: string
  folderName: string
  createdAt: string
}

type UploadFile = {
  id: string
  folderRelativePath: string
  fileName: string
  fileType: string
  previewStatus: string | null
  fileSize: number
  createdAt: string
}

type PendingUpload = {
  id: string
  folderId: string
  name: string
  status: 'uploading' | 'error'
  error?: string
}

interface AdminUploadManagerProps {
  projectId: string
  projectStatus: string
  canDelete?: boolean
  onProjectDataChanged?: () => void
  /** Reports folder/file counts so the parent can render a summary chip in the section header. */
  onSummaryChange?: (summary: { folderCount: number; fileCount: number }) => void
}

function fileIconFor(fileType: string) {
  const t = (fileType || '').toLowerCase()
  if (t.startsWith('image/')) return FileImage
  if (t.startsWith('video/')) return FileVideo
  if (t.startsWith('audio/')) return FileAudio
  if (t === 'application/pdf' || t.startsWith('text/')) return FileText
  if (t.includes('zip') || t.includes('compressed') || t.includes('tar') || t.includes('rar')) return FileArchive
  return FileIcon
}

export default function AdminUploadManager({
  projectId,
  projectStatus,
  canDelete = true,
  onProjectDataChanged,
  onSummaryChange,
}: AdminUploadManagerProps) {
  const [folders, setFolders] = useState<UploadFolder[]>([])
  const [files, setFiles] = useState<UploadFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expandedFolderId, setExpandedFolderId] = useState<string | null>(null)

  const [showNewForm, setShowNewForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [savingFolderId, setSavingFolderId] = useState<string | null>(null)

  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [draggingFolderId, setDraggingFolderId] = useState<string | null>(null)
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<{ id: string; name: string } | null>(null)
  const [pendingDeleteFile, setPendingDeleteFile] = useState<{ folderId: string; fileId: string; fileName: string } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadFolderIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchFolders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiJson<{ folders: UploadFolder[]; files: UploadFile[] }>(
        `/api/projects/${projectId}/upload-folders`,
      )
      setFolders(Array.isArray(data.folders) ? data.folders : [])
      setFiles(Array.isArray(data.files) ? data.files : [])
    } catch (err: any) {
      setError(err?.message || 'Failed to load upload folders')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void fetchFolders()
  }, [fetchFolders])

  // Top-level folders are the admin-managed cards; nested (client-created) subfolders
  // roll their files up into their parent's count.
  const topLevelFolders = useMemo(
    () => folders.filter((f) => !f.relativePath.includes('/')).sort((a, b) => a.folderName.localeCompare(b.folderName)),
    [folders],
  )

  const filesForFolder = useCallback(
    (relativePath: string) =>
      files
        .filter((f) => f.folderRelativePath === relativePath || f.folderRelativePath.startsWith(`${relativePath}/`))
        .sort((a, b) => a.fileName.localeCompare(b.fileName)),
    [files],
  )

  // Report the summary chip to the parent header.
  useEffect(() => {
    onSummaryChange?.({ folderCount: topLevelFolders.length, fileCount: files.length })
  }, [topLevelFolders.length, files.length, onSummaryChange])

  // Poll while any upload is still generating a preview so statuses settle without a manual refresh.
  const hasPendingPreview = useMemo(
    () => files.some((f) => f.previewStatus === 'PENDING' || f.previewStatus === 'PROCESSING'),
    [files],
  )
  useEffect(() => {
    if (!hasPendingPreview) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      return
    }
    if (pollTimerRef.current) return
    pollTimerRef.current = setInterval(() => {
      void fetchFolders()
    }, 8000)
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [hasPendingPreview, fetchFolders])

  const handleCreateFolder = async () => {
    const name = newName.trim()
    if (!name) return
    setCreating(true)
    try {
      const { folder } = await apiPost<{ folder: UploadFolder }>(
        `/api/projects/${projectId}/upload-folders`,
        { folderName: name },
      )
      setNewName('')
      setShowNewForm(false)
      await fetchFolders()
      setExpandedFolderId(folder?.id ?? null)
      onProjectDataChanged?.()
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create folder')
    } finally {
      setCreating(false)
    }
  }

  const handleRenameFolder = async (folderId: string) => {
    const name = editValue.trim()
    if (!name) return
    setSavingFolderId(folderId)
    try {
      await apiPatch(`/api/projects/${projectId}/upload-folders/${folderId}`, { folderName: name })
      setEditingFolderId(null)
      setEditValue('')
      await fetchFolders()
      onProjectDataChanged?.()
    } catch (err: any) {
      toast.error(err?.message || 'Failed to rename folder')
    } finally {
      setSavingFolderId(null)
    }
  }

  const handleDeleteFolder = async (folderId: string) => {
    await apiDelete(`/api/projects/${projectId}/upload-folders/${folderId}`)
    if (expandedFolderId === folderId) setExpandedFolderId(null)
    await fetchFolders()
    onProjectDataChanged?.()
  }

  const handleDeleteFile = async (folderId: string, fileId: string) => {
    await apiDelete(`/api/projects/${projectId}/upload-folders/${folderId}/files?fileId=${encodeURIComponent(fileId)}`)
    await fetchFolders()
    onProjectDataChanged?.()
  }

  const uploadFilesToFolder = async (folderId: string, selected: File[]) => {
    if (selected.length === 0) return
    // Upload sequentially — keeps memory bounded for large media and simplifies error tracking.
    for (const file of selected) {
      const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      setPendingUploads((prev) => [...prev, { id: pendingId, folderId, name: file.name, status: 'uploading' }])
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await apiFetch(`/api/projects/${projectId}/upload-folders/${folderId}/files`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error || `Upload failed (HTTP ${res.status})`)
        }
        setPendingUploads((prev) => prev.filter((p) => p.id !== pendingId))
      } catch (err: any) {
        setPendingUploads((prev) =>
          prev.map((p) => (p.id === pendingId ? { ...p, status: 'error', error: err?.message || 'Upload failed' } : p)),
        )
        toast.error(`${file.name}: ${err?.message || 'Upload failed'}`)
      }
    }
    await fetchFolders()
    onProjectDataChanged?.()
  }

  const openFilePicker = (folderId: string) => {
    uploadFolderIdRef.current = folderId
    fileInputRef.current?.click()
  }

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const folderId = uploadFolderIdRef.current
    const selected = e.target.files ? Array.from(e.target.files) : []
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!folderId || selected.length === 0) return
    void uploadFilesToFolder(folderId, selected)
  }

  const handleFolderDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDraggingFolderId(null)
    const dropped = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : []
    if (dropped.length > 0) void uploadFilesToFolder(folderId, dropped)
  }

  return (
    <div className="space-y-4">
      {/* Single hidden input reused across folders; target folder tracked via ref. */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {loading && folders.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading folders…
        </div>
      )}

      {topLevelFolders.length > 0 && (
        <div className="space-y-3">
          {topLevelFolders.map((folder) => {
            const folderFiles = filesForFolder(folder.relativePath)
            const isExpanded = expandedFolderId === folder.id
            const isEditing = editingFolderId === folder.id
            const folderPending = pendingUploads.filter((p) => p.folderId === folder.id)
            return (
              <Card key={folder.id} className="overflow-hidden transition-shadow hover:shadow-sm">
                <CardHeader
                  className={cn(
                    'cursor-pointer hover:bg-accent/50 transition-colors',
                    'flex flex-row items-center justify-between space-y-0 py-3',
                  )}
                  onClick={() => { if (!isEditing) setExpandedFolderId(isExpanded ? null : folder.id) }}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="relative shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-md overflow-hidden bg-muted ring-1 ring-border flex items-center justify-center">
                      <Folder className="w-6 h-6 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="min-w-0">
                        {isEditing ? (
                          <InlineEdit
                            value={editValue}
                            onChange={setEditValue}
                            onSave={() => void handleRenameFolder(folder.id)}
                            onCancel={() => { setEditingFolderId(null); setEditValue('') }}
                            disabled={savingFolderId === folder.id}
                            inputClassName="h-8 w-full sm:w-64"
                            stopPropagation
                          />
                        ) : (
                          <CardTitle className="text-lg leading-snug wrap-break-word">
                            <span>{folder.folderName}</span>
                            {projectStatus !== 'APPROVED' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="ml-1 h-6 w-6 text-muted-foreground hover:text-primary hover:bg-primary-visible inline-flex align-text-top"
                                onClick={(e) => { e.stopPropagation(); setEditingFolderId(folder.id); setEditValue(folder.folderName) }}
                                title="Rename folder"
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            )}
                          </CardTitle>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {folderFiles.length} file{folderFiles.length === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {isExpanded ? (
                      <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}
                  </div>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="border-t border-border pt-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <h4 className="text-sm font-medium">Upload Files</h4>
                        {canDelete && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setPendingDeleteFolder({ id: folder.id, name: folder.folderName })
                            }}
                          >
                            <Trash2 className="w-4 h-4 mr-2 text-destructive" />
                            Delete folder
                          </Button>
                        )}
                      </div>
                      <div
                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDraggingFolderId(folder.id) }}
                        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDraggingFolderId(null) }}
                        onDrop={(e) => handleFolderDrop(e, folder.id)}
                        className={cn(
                          'rounded-lg border-2 border-dashed transition-all',
                          draggingFolderId === folder.id ? 'border-primary bg-primary/5 scale-[1.01] p-4' : 'border-transparent',
                        )}
                      >
                        <Button type="button" variant="outline" onClick={() => openFilePicker(folder.id)} className="w-full">
                          <Upload className="w-4 h-4 mr-2" />
                          {folderFiles.length > 0 ? 'Add More Files' : 'Drag & Drop or Click to Choose'}
                        </Button>
                      </div>
                    </div>

                    {folderPending.length > 0 && (
                      <div className="space-y-1">
                        {folderPending.map((p) => (
                          <div key={p.id} className="flex items-center gap-2 text-xs">
                            {p.status === 'uploading' ? (
                              <Loader2 className="w-3 h-3 animate-spin text-primary" />
                            ) : (
                              <X className="w-3 h-3 text-destructive" />
                            )}
                            <span className="truncate">{p.name}</span>
                            {p.status === 'error' && <span className="text-destructive">{p.error}</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {folderFiles.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No files in this folder yet.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {folderFiles.map((file) => {
                          const Icon = fileIconFor(file.fileType)
                          const subPath = file.folderRelativePath === folder.relativePath
                            ? null
                            : file.folderRelativePath.slice(folder.relativePath.length + 1)
                          return (
                            <div
                              key={file.id}
                              className="flex items-center gap-2 rounded-md border bg-card p-2 group"
                            >
                              <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm truncate" title={file.fileName}>{file.fileName}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {subPath ? `${subPath} · ` : ''}{formatFileSize(file.fileSize || 0)}
                                  {(file.previewStatus === 'PENDING' || file.previewStatus === 'PROCESSING') && ' · preview…'}
                                </p>
                              </div>
                              {canDelete && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                  title="Delete file"
                                  onClick={() => setPendingDeleteFile({ folderId: folder.id, fileId: file.id, fileName: file.fileName })}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {!loading && topLevelFolders.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="rounded-full bg-muted p-3">
              <Upload className="w-6 h-6 text-muted-foreground" />
            </span>
            <p className="text-sm font-medium">No upload folders yet</p>
            <p className="text-sm text-muted-foreground">
              {projectStatus === 'APPROVED'
                ? 'This project is approved.'
                : 'Add a folder to share and collect files with your client.'}
            </p>
          </CardContent>
        </Card>
      )}

      {projectStatus !== 'APPROVED' && (
        <div>
          {!showNewForm ? (
            <Button
              variant="outline"
              size="lg"
              onClick={() => setShowNewForm(true)}
              className="w-full border-dashed"
              disabled={creating}
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Folder
            </Button>
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Add Folder</CardTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => { setShowNewForm(false); setNewName('') }}
                  disabled={creating}
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="new-upload-folder-name">Folder Name *</Label>
                  <Input
                    id="new-upload-folder-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g., Source Footage, Raw Assets, Deliverables"
                    autoFocus
                    disabled={creating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleCreateFolder()
                      if (e.key === 'Escape') { setShowNewForm(false); setNewName('') }
                    }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button onClick={() => void handleCreateFolder()} disabled={creating || !newName.trim()}>
                    {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                    Create Folder
                  </Button>
                  <Button variant="ghost" onClick={() => { setShowNewForm(false); setNewName('') }} disabled={creating}>
                    Cancel
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteFolder !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteFolder(null) }}
        title="Delete folder?"
        description={pendingDeleteFolder ? `"${pendingDeleteFolder.name}" and all of its files and subfolders will be permanently deleted.` : undefined}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDeleteFolder) return
          try {
            await handleDeleteFolder(pendingDeleteFolder.id)
          } catch (err: any) {
            toast.error(err?.message || 'Failed to delete folder')
          } finally {
            setPendingDeleteFolder(null)
          }
        }}
      />

      <ConfirmDialog
        open={pendingDeleteFile !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteFile(null) }}
        title="Delete file?"
        description={pendingDeleteFile ? `"${pendingDeleteFile.fileName}" will be permanently deleted.` : undefined}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDeleteFile) return
          try {
            await handleDeleteFile(pendingDeleteFile.folderId, pendingDeleteFile.fileId)
          } catch (err: any) {
            toast.error(err?.message || 'Failed to delete file')
          } finally {
            setPendingDeleteFile(null)
          }
        }}
      />
    </div>
  )
}
