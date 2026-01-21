'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ChevronDown, ChevronUp, Images, Plus, Trash2 } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import { apiDelete, apiJson, apiPost } from '@/lib/api-client'
import { AlbumPhotoUploadQueue } from '@/components/AlbumPhotoUploadQueue'

type AlbumSummary = {
  id: string
  name: string
  notes: string | null
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
}

type PhotoSortMode = 'alphabetical' | 'upload-date'

export default function AdminAlbumManager({ projectId, projectStatus, canDelete = true }: AdminAlbumManagerProps) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expandedAlbumId, setExpandedAlbumId] = useState<string | null>(null)

  const [showNewAlbumForm, setShowNewAlbumForm] = useState(false)
  const [newAlbumName, setNewAlbumName] = useState('')
  const [newAlbumNotes, setNewAlbumNotes] = useState('')
  const [creating, setCreating] = useState(false)

  const [photosByAlbumId, setPhotosByAlbumId] = useState<Record<string, AlbumPhoto[]>>({})
  const [photosLoadingByAlbumId, setPhotosLoadingByAlbumId] = useState<Record<string, boolean>>({})
  const [photoSortModeByAlbumId, setPhotoSortModeByAlbumId] = useState<Record<string, PhotoSortMode>>({})

  const [zipStatusByAlbumId, setZipStatusByAlbumId] = useState<Record<string, AlbumZipStatus | null>>({})
  const zipPollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refreshAlbumsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshPhotosTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const hasAlbums = albums.length > 0

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
      if (!nextAlbums.length) {
        setShowNewAlbumForm(true)
      }
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

  const fetchZipStatus = useCallback(async (albumId: string) => {
    try {
      const data = await apiJson<AlbumZipStatus>(`/api/albums/${albumId}/zip-status`)
      setZipStatusByAlbumId((prev) => ({ ...prev, [albumId]: data }))

      // Poll while work is still in progress so the admin can see progress.
      const shouldPoll =
        !data.zip.fullReady ||
        !data.zip.socialReady ||
        data.counts.uploading > 0 ||
        data.counts.socialPending > 0

      const prevTimer = zipPollTimersRef.current.get(albumId)
      if (prevTimer) clearTimeout(prevTimer)

      if (shouldPoll && expandedAlbumId === albumId) {
        zipPollTimersRef.current.set(
          albumId,
          setTimeout(() => {
            void fetchZipStatus(albumId)
          }, 5000)
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
    } catch (e: any) {
      alert(e?.message || 'Failed to regenerate ZIPs')
    }
  }, [fetchZipStatus])

  const handleDeleteAlbum = async (albumId: string, albumName: string) => {
    if (!canDelete) return
    if (!confirm(`Delete album "${albumName}" and all photos?`)) return

    try {
      await apiDelete(`/api/albums/${albumId}`)

      setAlbums((prev) => {
        const next = prev.filter((a) => a.id !== albumId)
        if (next.length === 0) {
          setShowNewAlbumForm(true)
        }
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

      setPhotosByAlbumId((prev) => ({
        ...prev,
        [albumId]: (prev[albumId] || []).filter((p) => p.id !== photoId),
      }))

      setAlbums((prev) =>
        prev.map((a) => {
          if (a.id !== albumId) return a
          if (!a._count || typeof a._count.photos !== 'number') return a
          return {
            ...a,
            _count: { photos: Math.max(0, (a._count.photos || 0) - 1) },
          }
        })
      )
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
                  <CardTitle className="text-lg truncate">{album.name}</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {count} photo{count === 1 ? '' : 's'}
                  </p>
                </div>
              </div>

              {isExpanded ? (
                <ChevronUp className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              )}
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
              <CardHeader>
                <CardTitle>Add Album</CardTitle>
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
                  <p className="text-xs text-muted-foreground mt-1">Max 500 characters</p>
                </div>

                <div className="flex gap-2">
                  <Button type="button" onClick={() => void handleCreateAlbum()} disabled={creating}>
                    Create Album
                  </Button>
                  {hasAlbums && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setShowNewAlbumForm(false)
                        setNewAlbumName('')
                        setNewAlbumNotes('')
                      }}
                      disabled={creating}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
