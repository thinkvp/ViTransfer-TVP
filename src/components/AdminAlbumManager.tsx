'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ChevronDown, ChevronUp, Images, Plus, Trash2, Pencil, X } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { AlbumPhotoUploadQueue } from '@/components/AlbumPhotoUploadQueue'
import { InlineEdit } from '@/components/InlineEdit'

type AlbumSummary = {
  id: string
  name: string
  notes: string | null
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  createdAt: string
  updatedAt: string
  _count?: { photos?: number }
}

type AlbumPhoto = {
  id: string
  albumId: string
  fileName: string
  fileSize: string | number
  fileType: string
  storagePath: string
  status: string
  error: string | null
  createdAt: string
  updatedAt: string
}

type AlbumZipStatus = {
  album?: { status?: string }
  zip: { fullReady: boolean; socialReady: boolean }
  counts: {
    uploading: number
    ready: number
    socialReady: number
    socialPending: number
    socialError: number
  }
}

interface AdminAlbumManagerProps {
  projectId: string
  projectStatus: string
  canDelete?: boolean
  onProjectDataChanged?: () => void
}

type PhotoSortMode = 'alphabetical' | 'upload-date'

export default function AdminAlbumManager({ projectId, projectStatus, canDelete = true, onProjectDataChanged }: AdminAlbumManagerProps) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expandedAlbumId, setExpandedAlbumId] = useState<string | null>(null)

  const [showNewAlbumForm, setShowNewAlbumForm] = useState(false)
  const [newAlbumName, setNewAlbumName] = useState('')
  const [newAlbumNotes, setNewAlbumNotes] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null)
  const [editAlbumValue, setEditAlbumValue] = useState('')
  const [savingAlbumId, setSavingAlbumId] = useState<string | null>(null)

  const [photosByAlbumId, setPhotosByAlbumId] = useState<Record<string, AlbumPhoto[]>>({})
  const [photosLoadingByAlbumId, setPhotosLoadingByAlbumId] = useState<Record<string, boolean>>({})
  const [photoSortModeByAlbumId, setPhotoSortModeByAlbumId] = useState<Record<string, PhotoSortMode>>({})

  const [zipStatusByAlbumId, setZipStatusByAlbumId] = useState<Record<string, AlbumZipStatus | null>>({})
  const zipPollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refreshAlbumsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshPhotosTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const sortedAlbums = useMemo(() => {
    return [...albums].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [albums])

  async function fetchAlbums() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiJson<{ albums?: AlbumSummary[] }>(`/api/projects/${projectId}/albums`)
      const nextAlbums = data.albums || []
      setAlbums(nextAlbums)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load albums'

      // During bulk uploads, we may refresh frequently; ignore transient rate limiting
      // if we already have album data rendered.
      const isRateLimit = message.toLowerCase().includes('too many requests') || message.includes('HTTP 429')
      if (isRateLimit && albums.length > 0) return

      setError(message)
    } finally {
      setLoading(false)
    }
  }

  async function fetchPhotos(albumId: string) {
    setPhotosLoadingByAlbumId((prev) => ({ ...prev, [albumId]: true }))
    try {
      const data = await apiJson<{ photos?: AlbumPhoto[] }>(`/api/albums/${albumId}/photos`)
      setPhotosByAlbumId((prev) => ({ ...prev, [albumId]: data.photos || [] }))
    } catch {
      // ignore
    } finally {
      setPhotosLoadingByAlbumId((prev) => ({ ...prev, [albumId]: false }))
    }
  }

  const scheduleRefreshAfterUpload = useCallback(
    (albumId: string) => {
      onProjectDataChanged?.()

      // Debounce photos refresh per-album
      const prevPhotoTimer = refreshPhotosTimersRef.current.get(albumId)
      if (prevPhotoTimer) clearTimeout(prevPhotoTimer)
      refreshPhotosTimersRef.current.set(
        albumId,
        setTimeout(() => {
          void fetchPhotos(albumId)
        }, 750)
      )

      // Debounce albums refresh (counts) globally
      if (refreshAlbumsTimerRef.current) clearTimeout(refreshAlbumsTimerRef.current)
      refreshAlbumsTimerRef.current = setTimeout(() => {
        void fetchAlbums()
      }, 1500)
    },
    // fetchAlbums/fetchPhotos are stable enough for this usage; projectId changes will
    // remount the component and the timers will be cleared in cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId]
  )

  useEffect(() => {
    const photosTimers = refreshPhotosTimersRef.current
    const zipTimers = zipPollTimersRef.current
    return () => {
      if (refreshAlbumsTimerRef.current) clearTimeout(refreshAlbumsTimerRef.current)
      for (const timer of photosTimers.values()) {
        clearTimeout(timer)
      }
      photosTimers.clear()

      for (const timer of zipTimers.values()) {
        clearTimeout(timer)
      }
      zipTimers.clear()
    }
  }, [])

  useEffect(() => {
    void fetchAlbums()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Refresh the album list in the background while any album is still uploading/processing.
  // This keeps the header pill in sync (similar to how videos update as status changes).
  useEffect(() => {
    const hasBusyAlbums = albums.some((a) => a.status === 'UPLOADING' || a.status === 'PROCESSING')
    if (!hasBusyAlbums) return

    const timer = setTimeout(() => {
      void fetchAlbums()
    }, 15000)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albums, projectId])

  const toggleAlbum = async (albumId: string) => {
    const wasExpanded = expandedAlbumId === albumId
    if (wasExpanded) {
      setExpandedAlbumId(null)
      return
    }

    setExpandedAlbumId(albumId)
    if (!photosByAlbumId[albumId]) {
      await fetchPhotos(albumId)
    }

    // Fetch ZIP status when opening the album
    void fetchZipStatus(albumId)
  }

  const handleStartEditAlbumName = (albumId: string, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingAlbumId(albumId)
    setEditAlbumValue(currentName)
  }

  const handleCancelEditAlbumName = () => {
    setEditingAlbumId(null)
    setEditAlbumValue('')
  }

  const handleSaveAlbumName = async (albumId: string) => {
    const nextName = editAlbumValue.trim()
    if (!nextName) {
      alert('Album name cannot be empty')
      return
    }

    setSavingAlbumId(albumId)
    apiPatch(`/api/albums/${albumId}`, { name: nextName })
      .then(() => {
        setAlbums((prev) => prev.map((a) => (a.id === albumId ? { ...a, name: nextName } : a)))
        setEditingAlbumId(null)
        setEditAlbumValue('')
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : 'Failed to update album name'
        alert(message)
      })
      .finally(() => {
        setSavingAlbumId(null)
      })
  }

  const fetchZipStatus = useCallback(async (albumId: string) => {
    try {
      const data = await apiJson<AlbumZipStatus>(`/api/albums/${albumId}/zip-status`)
      setZipStatusByAlbumId((prev) => ({ ...prev, [albumId]: data }))

      // If the endpoint reports the album status (e.g. after self-healing),
      // update the local album list so the header pill reflects reality.
      if (data?.album?.status) {
        setAlbums((prev) => prev.map((a) => (a.id === albumId ? { ...a, status: data.album!.status as any } : a)))
      }

      // Poll while work is still in progress so the admin can see progress.
      const shouldPoll =
        !data.zip.fullReady ||
        !data.zip.socialReady ||
        data.counts.uploading > 0 ||
        data.counts.socialPending > 0

      const prevTimer = zipPollTimersRef.current.get(albumId)
      if (prevTimer) clearTimeout(prevTimer)

      // Poll until the zips are ready so the UI can update even when the album is collapsed.
      // Use a faster interval when expanded, slower when collapsed.
      if (shouldPoll) {
        const intervalMs = expandedAlbumId === albumId ? 5000 : 15000
        zipPollTimersRef.current.set(
          albumId,
          setTimeout(() => {
            void fetchZipStatus(albumId)
          }, intervalMs)
        )
      }
    } catch {
      // ignore
    }
  }, [expandedAlbumId])

  const regenerateZips = useCallback(async (albumId: string) => {
    try {
      await apiPost(`/api/albums/${albumId}/zip-regenerate`, {})
      // Refresh status quickly after clicking regenerate
      void fetchZipStatus(albumId)
      onProjectDataChanged?.()
    } catch (e: any) {
      alert(e?.message || 'Failed to regenerate ZIPs')
    }
  }, [fetchZipStatus, onProjectDataChanged])

  const handleDeleteAlbum = async (albumId: string, albumName: string) => {
    if (!canDelete) return
    if (!confirm(`Delete album "${albumName}" and all photos?`)) return

    try {
      await apiDelete(`/api/albums/${albumId}`)

      onProjectDataChanged?.()

      setAlbums((prev) => {
        const next = prev.filter((a) => a.id !== albumId)
        return next
      })
      setPhotosByAlbumId((prev) => {
        const next = { ...prev }
        delete next[albumId]
        return next
      })

      setPhotosLoadingByAlbumId((prev) => {
        const next = { ...prev }
        delete next[albumId]
        return next
      })

      setZipStatusByAlbumId((prev) => {
        const next = { ...prev }
        delete next[albumId]
        return next
      })

      const zipTimer = zipPollTimersRef.current.get(albumId)
      if (zipTimer) {
        clearTimeout(zipTimer)
        zipPollTimersRef.current.delete(albumId)
      }

      if (expandedAlbumId === albumId) {
        setExpandedAlbumId(null)
      }
    } catch (e: any) {
      alert(e?.message || 'Failed to delete album')
    }
  }

  const handleDeletePhoto = async (albumId: string, photoId: string, fileName: string) => {
    if (!canDelete) return
    if (!confirm(`Delete photo "${fileName}"?`)) return

    try {
      await apiDelete(`/api/albums/${albumId}/photos/${photoId}`)

      onProjectDataChanged?.()

      // The delete endpoint invalidates ZIPs and moves the album into PROCESSING.
      // Optimistically reflect that here so the header pill updates immediately.
      setAlbums((prev) =>
        prev.map((a) => {
          if (a.id !== albumId) return a
          const nextCount =
            a._count && typeof a._count.photos === 'number' ? Math.max(0, (a._count.photos || 0) - 1) : undefined
          return {
            ...a,
            status: 'PROCESSING',
            _count: nextCount === undefined ? a._count : { photos: nextCount },
          }
        })
      )

      setPhotosByAlbumId((prev) => ({
        ...prev,
        [albumId]: (prev[albumId] || []).filter((p) => p.id !== photoId),
      }))

      // Kick the ZIP status UI (and its polling) to update immediately.
      void fetchZipStatus(albumId)

      // Also refresh the albums list shortly after, so status/counts stay accurate.
      if (refreshAlbumsTimerRef.current) clearTimeout(refreshAlbumsTimerRef.current)
      refreshAlbumsTimerRef.current = setTimeout(() => {
        void fetchAlbums()
      }, 1000)
    } catch (e: any) {
      alert(e?.message || 'Failed to delete photo')
    }
  }

  const handleCreateAlbum = async () => {
    const name = newAlbumName.trim()
    const notes = newAlbumNotes.trim()

    if (!name) {
      setError('Album name is required')
      return
    }
    if (notes.length > 500) {
      setError('Album notes must be 500 characters or fewer')
      return
    }

    setCreating(true)
    setError(null)
    try {
      const res = await apiPost(`/api/projects/${projectId}/albums`, {
        name,
        notes: notes ? notes : null,
      })

      setNewAlbumName('')
      setNewAlbumNotes('')
      setShowNewAlbumForm(false)

      await fetchAlbums()
      if (res?.album?.id) {
        setExpandedAlbumId(res.album.id)
        await fetchPhotos(res.album.id)
      }
    } catch {
      setError('Failed to create album')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>
        </div>
      )}

      {loading && (
        <div className="text-sm text-muted-foreground">Loading albums…</div>
      )}

      {sortedAlbums.map((album) => {
        const isExpanded = expandedAlbumId === album.id
        const count = album._count?.photos ?? (photosByAlbumId[album.id]?.length ?? 0)
        const photos = photosByAlbumId[album.id] || []
        const photosLoading = photosLoadingByAlbumId[album.id]
        const photoSortMode = photoSortModeByAlbumId[album.id] || 'alphabetical'

        const sortedPhotos = (() => {
          if (photos.length <= 1) return photos
          const next = [...photos]
          if (photoSortMode === 'upload-date') {
            next.sort((a, b) => {
              const aTime = new Date(a.createdAt).getTime()
              const bTime = new Date(b.createdAt).getTime()
              const delta = bTime - aTime
              if (delta !== 0) return delta
              return String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, {
                numeric: true,
                sensitivity: 'base',
              })
            })
            return next
          }

          next.sort((a, b) =>
            String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, {
              numeric: true,
              sensitivity: 'base',
            })
          )
          return next
        })()

        return (
          <Card key={album.id} className="overflow-hidden">
            <CardHeader
              className={cn(
                'cursor-pointer hover:bg-accent/50 transition-colors',
                'flex flex-row items-center justify-between space-y-0 py-3'
              )}
              onClick={() => void toggleAlbum(album.id)}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Images className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="min-w-0">
                    {editingAlbumId === album.id ? (
                      <InlineEdit
                        value={editAlbumValue}
                        onChange={setEditAlbumValue}
                        onSave={() => handleSaveAlbumName(album.id)}
                        onCancel={handleCancelEditAlbumName}
                        disabled={savingAlbumId === album.id}
                        inputClassName="h-8 w-full sm:w-64"
                        stopPropagation={true}
                      />
                    ) : (
                      <div className="min-w-0">
                        <CardTitle className="text-lg leading-snug break-words">
                          <span>{album.name}</span>
                          {projectStatus !== 'APPROVED' && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="ml-1 h-6 w-6 text-muted-foreground hover:text-primary hover:bg-primary-visible inline-flex align-text-top"
                              onClick={(e) => handleStartEditAlbumName(album.id, album.name, e)}
                              title="Edit album name"
                            >
                              <Pencil className="w-3 h-3" />
                            </Button>
                          )}
                        </CardTitle>
                      </div>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {count} photo{count === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {(album.status === 'UPLOADING' || album.status === 'PROCESSING') && Number(count) > 0 && (
                  <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-primary-visible text-primary border-2 border-primary-visible">
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-primary" />
                    PROCESSING
                  </span>
                )}

                {isExpanded ? (
                  <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                )}
              </div>
            </CardHeader>

            {isExpanded && (
              <CardContent className="border-t border-border pt-4 space-y-4">
                {album.notes && (
                  <div className="text-sm">
                    <p className="text-muted-foreground">Album Notes</p>
                    <div className="mt-1 whitespace-pre-wrap break-words">{album.notes}</div>
                  </div>
                )}

                <div className="rounded-md border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Download ZIPs</p>
                      <div className="mt-1 text-xs text-muted-foreground space-y-1">
                        {(() => {
                          const status = zipStatusByAlbumId[album.id]
                          if (!status) return <p>Checking status…</p>

                          const full = status.zip.fullReady ? 'Ready' : 'Not ready'
                          const social = status.zip.socialReady ? 'Ready' : 'Not ready'

                          return (
                            <>
                              <p>Full resolution ZIP: {full}</p>
                              <p>Social media ZIP: {social}</p>
                              <p>
                                Uploads in progress: {status.counts.uploading} • Social derivatives: {status.counts.socialReady} ready, {status.counts.socialPending} pending, {status.counts.socialError} error
                              </p>
                            </>
                          )
                        })()}
                      </div>
                    </div>

                    <Button type="button" variant="outline" size="sm" onClick={() => void regenerateZips(album.id)}>
                      Regenerate ZIPs
                    </Button>
                  </div>
                </div>

                {projectStatus !== 'APPROVED' && (
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-medium">Upload Photos</h4>
                        <p className="text-xs text-muted-foreground mt-1">Upload up to 300 photos at a time.</p>
                      </div>

                      {canDelete && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void handleDeleteAlbum(album.id, album.name)
                          }}
                        >
                          <Trash2 className="w-4 h-4 mr-2 text-destructive" />
                          Delete album
                        </Button>
                      )}
                    </div>
                    <AlbumPhotoUploadQueue
                      albumId={album.id}
                      maxConcurrent={3}
                      onUploadComplete={() => {
                        scheduleRefreshAfterUpload(album.id)
                        void fetchZipStatus(album.id)
                      }}
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">Photos</h4>
                    <div className="flex items-center gap-2">
                      {canDelete && projectStatus === 'APPROVED' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void handleDeleteAlbum(album.id, album.name)
                          }}
                        >
                          <Trash2 className="w-4 h-4 mr-2 text-destructive" />
                          Delete album
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setPhotoSortModeByAlbumId((prev) => ({
                            ...prev,
                            [album.id]: (prev[album.id] || 'alphabetical') === 'alphabetical' ? 'upload-date' : 'alphabetical',
                          }))
                        }
                      >
                        Sort: {photoSortMode === 'alphabetical' ? 'A–Z' : 'Upload date'}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void fetchPhotos(album.id)}>
                        Refresh
                      </Button>
                    </div>
                  </div>

                  {photosLoading ? (
                    <p className="text-sm text-muted-foreground">Loading photos…</p>
                  ) : photos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No photos yet</p>
                  ) : (
                    <div className="space-y-2">
                      {sortedPhotos.map((p) => (
                        <div key={p.id} className="flex items-center justify-between gap-3 p-2 rounded-md border bg-card">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{p.fileName}</p>
                            <p className="text-xs text-muted-foreground">
                              {typeof p.fileSize === 'string' ? formatFileSize(Number(p.fileSize)) : formatFileSize(p.fileSize)}
                              {' • '}
                              {p.status}
                              {p.error ? ` • ${p.error}` : ''}
                            </p>
                          </div>

                          {canDelete && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void handleDeletePhoto(album.id, p.id, p.fileName)
                              }}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}

      {projectStatus !== 'APPROVED' && (
        <div>
          {!showNewAlbumForm ? (
            <Button
              variant="outline"
              size="lg"
              onClick={() => setShowNewAlbumForm(true)}
              className="w-full border-dashed"
              disabled={creating}
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Album
            </Button>
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Add Album</CardTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setShowNewAlbumForm(false)
                    setNewAlbumName('')
                    setNewAlbumNotes('')
                  }}
                  disabled={creating}
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="albumName">Album Name *</Label>
                  <Input
                    id="albumName"
                    value={newAlbumName}
                    onChange={(e) => setNewAlbumName(e.target.value)}
                    placeholder="e.g., Location Stills, BTS, Screenshots"
                    required
                    disabled={creating}
                  />
                </div>

                <div>
                  <Label htmlFor="albumNotes">
                    Album Notes <span className="text-muted-foreground">(Optional)</span>
                  </Label>
                  <Textarea
                    id="albumNotes"
                    value={newAlbumNotes}
                    onChange={(e) => setNewAlbumNotes(e.target.value)}
                    placeholder="Optional notes about this album"
                    className="resize-none"
                    rows={3}
                    maxLength={500}
                    disabled={creating}
                  />
                </div>

                <div className="flex justify-end">
                  <Button type="button" onClick={() => void handleCreateAlbum()} disabled={creating}>
                    Create Album
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
