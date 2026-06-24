'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ChevronDown, ChevronUp, Images, Plus, Trash2, Pencil, X, Loader2, Layers, RotateCw, ArrowUpDown } from 'lucide-react'
import { cn, formatFileSize } from '@/lib/utils'
import { apiDelete, apiJson, apiPatch, apiPost } from '@/lib/api-client'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { AlbumPhotoUploadQueue } from '@/components/AlbumPhotoUploadQueue'
import { InlineEdit } from '@/components/InlineEdit'

type AlbumSummary = {
  id: string
  name: string
  notes: string | null
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'ERROR'
  socialCopiesEnabled: boolean
  createdAt: string
  updatedAt: string
  coverThumbnailUrl?: string | null
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
  thumbnailStatus?: string
  thumbnailUrl?: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

type AlbumZipStatus = {
  album?: { status?: string }
  socialCopiesEnabled?: boolean
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
  /** Reports album/photo counts so the parent can render a summary chip in the section header. */
  onSummaryChange?: (summary: { albumCount: number; photoCount: number }) => void
}

type PhotoSortMode = 'alphabetical' | 'upload-date'

export default function AdminAlbumManager({ projectId, projectStatus, canDelete = true, onProjectDataChanged, onSummaryChange }: AdminAlbumManagerProps) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [expandedAlbumId, setExpandedAlbumId] = useState<string | null>(null)

  const [showNewAlbumForm, setShowNewAlbumForm] = useState(false)
  const [newAlbumName, setNewAlbumName] = useState('')
  const [newAlbumNotes, setNewAlbumNotes] = useState('')
  const [newAlbumSocialCopies, setNewAlbumSocialCopies] = useState(true)
  const [creating, setCreating] = useState(false)

  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null)
  const [editAlbumValue, setEditAlbumValue] = useState('')
  const [savingAlbumId, setSavingAlbumId] = useState<string | null>(null)

  // S3 rename confirmation modal
  const [renameConfirmAlbumId, setRenameConfirmAlbumId] = useState<string | null>(null)
  const [renameConfirmAlbumName, setRenameConfirmAlbumName] = useState('')
  const [renameConfirming, setRenameConfirming] = useState(false)

  const [photosByAlbumId, setPhotosByAlbumId] = useState<Record<string, AlbumPhoto[]>>({})
  const [photosLoadingByAlbumId, setPhotosLoadingByAlbumId] = useState<Record<string, boolean>>({})
  const [photoSortModeByAlbumId, setPhotoSortModeByAlbumId] = useState<Record<string, PhotoSortMode>>({})

  const [zipStatusByAlbumId, setZipStatusByAlbumId] = useState<Record<string, AlbumZipStatus | null>>({})
  const zipPollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const refreshAlbumsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshPhotosTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const [togglingSocialCopiesAlbumId, setTogglingSocialCopiesAlbumId] = useState<string | null>(null)
  const [pendingDisableSocialAlbumId, setPendingDisableSocialAlbumId] = useState<string | null>(null)
  const [pendingDeleteAlbum, setPendingDeleteAlbum] = useState<{ id: string; name: string } | null>(null)
  const [pendingDeletePhoto, setPendingDeletePhoto] = useState<{ albumId: string; photoId: string; fileName: string } | null>(null)

  // Reprocess state per album
  const [reprocessingAlbumIds, setReprocessingAlbumIds] = useState<Set<string>>(new Set())
  // Reprocess confirmation modal
  const [reprocessConfirm, setReprocessConfirm] = useState<{ id: string; name: string } | null>(null)

  const runReprocessAlbum = async (albumId: string) => {
    setReprocessingAlbumIds((prev) => new Set(prev).add(albumId))
    try {
      await apiPost(`/api/albums/${albumId}/reprocess`, {})
      toast.success('Album queued for reprocessing')
      onProjectDataChanged?.()
      void fetchAlbums()
    } catch (err: any) {
      toast.error(err?.message || 'Failed to reprocess album')
    } finally {
      setReprocessingAlbumIds((prev) => {
        const next = new Set(prev)
        next.delete(albumId)
        return next
      })
    }
  }

  const sortedAlbums = useMemo(() => {
    return [...albums].sort((a, b) => {
      const nameCompare = String(a.name || '').localeCompare(String(b.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
      if (nameCompare !== 0) return nameCompare
      return a.createdAt < b.createdAt ? 1 : -1
    })
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

  // Report album/photo counts upward for the section header summary chip.
  useEffect(() => {
    const photoCount = albums.reduce((sum, a) => sum + (a._count?.photos ?? 0), 0)
    onSummaryChange?.({ albumCount: albums.length, photoCount })
  }, [albums, onSummaryChange])

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
      toast.error('Album name cannot be empty')
      return
    }

    setSavingAlbumId(albumId)
    try {
      const result = await apiPatch<any>(`/api/albums/${albumId}`, { name: nextName })

      // S3 mode: server returns 202 asking user to confirm the background rename
      if (result?.requiresJobConfirmation) {
        setRenameConfirmAlbumId(albumId)
        setRenameConfirmAlbumName(nextName)
        // Keep the edit field open so the user can see what they typed
        return
      }

      setAlbums((prev) => prev.map((a) => (a.id === albumId ? { ...a, name: nextName } : a)))
      setEditingAlbumId(null)
      setEditAlbumValue('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update album name')
    } finally {
      setSavingAlbumId(null)
    }
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
      toast.error(e?.message || 'Failed to regenerate ZIPs')
    }
  }, [fetchZipStatus, onProjectDataChanged])

  const executeSocialToggle = useCallback(async (albumId: string, enable: boolean) => {
    setTogglingSocialCopiesAlbumId(albumId)
    try {
      await apiPost(`/api/albums/${albumId}/social-copies`, { enabled: enable })
      setAlbums((prev) => prev.map((a) => a.id === albumId ? { ...a, socialCopiesEnabled: enable } : a))
      void fetchZipStatus(albumId)
    } catch (e: any) {
      toast.error(e?.message || 'Failed to toggle social downloads')
    } finally {
      setTogglingSocialCopiesAlbumId(null)
    }
  }, [fetchZipStatus])

  const handleToggleSocialCopies = useCallback(async (albumId: string, currentlyEnabled: boolean) => {
    if (togglingSocialCopiesAlbumId) return

    if (currentlyEnabled) {
      setPendingDisableSocialAlbumId(albumId)
      return
    }

    await executeSocialToggle(albumId, true)
  }, [togglingSocialCopiesAlbumId, executeSocialToggle])

  const handleDeleteAlbum = (albumId: string, albumName: string) => {
    if (!canDelete) return
    setPendingDeleteAlbum({ id: albumId, name: albumName })
  }

  const confirmDeleteAlbum = async () => {
    const { id: albumId } = pendingDeleteAlbum!
    setPendingDeleteAlbum(null)
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
      toast.error(e?.message || 'Failed to delete album')
    }
  }

  const handleDeletePhoto = (albumId: string, photoId: string, fileName: string) => {
    if (!canDelete) return
    setPendingDeletePhoto({ albumId, photoId, fileName })
  }

  const confirmDeletePhoto = async () => {
    const { albumId, photoId } = pendingDeletePhoto!
    setPendingDeletePhoto(null)
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
      toast.error(e?.message || 'Failed to delete photo')
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
        socialCopiesEnabled: newAlbumSocialCopies,
      })

      setNewAlbumName('')
      setNewAlbumNotes('')
      setNewAlbumSocialCopies(true)
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
    <>
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
          <Card key={album.id} className="overflow-hidden transition-shadow hover:shadow-sm">
            <CardHeader
              className={cn(
                'cursor-pointer hover:bg-accent/50 transition-colors',
                'flex flex-row items-center justify-between space-y-0 py-3'
              )}
              onClick={() => void toggleAlbum(album.id)}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {(() => {
                  const isReprocessing = reprocessingAlbumIds.has(album.id)
                  // Approved projects can still be reprocessed (server only blocks CLOSED).
                  const canReprocess = projectStatus !== 'CLOSED'
                  const hasError = album.status === 'ERROR'
                  const hasBusy = album.status === 'UPLOADING' || album.status === 'PROCESSING'
                  // Status accent: destructive for error, warning for busy, neutral border when healthy.
                  const ringColor = hasError
                    ? 'ring-destructive/60'
                    : hasBusy
                    ? 'ring-warning/60'
                    : 'ring-border'
                  const iconColor = hasError
                    ? 'text-destructive'
                    : hasBusy
                    ? 'text-warning'
                    : 'text-primary'
                  const coverUrl = album.coverThumbnailUrl

                  const handleReprocess = (e: React.MouseEvent) => {
                    e.stopPropagation()
                    if (!canReprocess || isReprocessing) return
                    setReprocessConfirm({ id: album.id, name: album.name })
                  }

                  return (
                    <div
                      className={cn(
                        'relative flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-md overflow-hidden bg-muted ring-1',
                        ringColor
                      )}
                    >
                      {/* eslint-disable @next/next/no-img-element */}
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt={album.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={() => {
                            // Token likely expired — drop the URL so we show the icon;
                            // the next fetchAlbums() re-mints a fresh cover token.
                            setAlbums((prev) =>
                              prev.map((x) => (x.id === album.id ? { ...x, coverThumbnailUrl: null } : x))
                            )
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Images className={`w-5 h-5 ${iconColor}`} />
                        </div>
                      )}
                      {/* eslint-enable @next/next/no-img-element */}

                      {isReprocessing ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                          <Loader2 className="w-4 h-4 text-white animate-spin" />
                        </div>
                      ) : canReprocess ? (
                        <button
                          type="button"
                          title="Reprocess album (ZIPs, thumbnails, social copies)"
                          onClick={handleReprocess}
                          className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition-all hover:bg-black/45 hover:opacity-100 focus-visible:bg-black/45 focus-visible:opacity-100"
                        >
                          <RotateCw className="w-4 h-4" />
                        </button>
                      ) : null}
                    </div>
                  )
                })()}
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
                {album.status === 'ERROR' && (
                  <span className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 bg-destructive-visible text-destructive border-2 border-destructive-visible">
                    FAILED
                  </span>
                )}
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
              <CardContent className="border-t border-border pt-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                {album.notes && (
                  <div className="text-sm">
                    <p className="text-muted-foreground">Album Notes</p>
                    <div className="mt-1 whitespace-pre-wrap break-words">{album.notes}</div>
                  </div>
                )}

                <div className="rounded-md border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium">Download ZIPs</p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-8 w-8',
                          album.socialCopiesEnabled
                            ? 'text-primary hover:text-primary/80 hover:bg-primary/5'
                            : 'text-muted-foreground hover:text-primary hover:bg-primary/5'
                        )}
                        disabled={togglingSocialCopiesAlbumId === album.id}
                        onClick={() => handleToggleSocialCopies(album.id, album.socialCopiesEnabled)}
                        title={album.socialCopiesEnabled ? 'Disable social media downloads' : 'Enable social media downloads'}
                      >
                        {togglingSocialCopiesAlbumId === album.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Layers className="w-4 h-4" />
                        )}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => void regenerateZips(album.id)}>
                        Regenerate ZIPs
                      </Button>
                    </div>
                  </div>

                  {(() => {
                    const status = zipStatusByAlbumId[album.id]
                    if (!status) {
                      return <p className="mt-2 text-xs text-muted-foreground">Checking status…</p>
                    }

                    const ZipRow = ({ label, ready, hint }: { label: string; ready: boolean; hint?: string }) => (
                      <div className="flex items-center justify-between gap-3 py-1.5">
                        <p className="text-sm">{label}</p>
                        <div className="flex items-center gap-2">
                          {hint && !ready ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                              ready
                                ? 'bg-success-visible text-success'
                                : 'bg-warning-visible text-warning'
                            )}
                          >
                            <span className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-success' : 'bg-warning animate-pulse')} />
                            {ready ? 'Ready' : 'Building…'}
                          </span>
                        </div>
                      </div>
                    )

                    const socialHint = album.socialCopiesEnabled
                      ? `${status.counts.socialReady} ready · ${status.counts.socialPending} pending${status.counts.socialError ? ` · ${status.counts.socialError} error` : ''}`
                      : undefined

                    return (
                      <div className="mt-2 divide-y divide-border/60">
                        <ZipRow
                          label="Full resolution"
                          ready={status.zip.fullReady}
                          hint={status.counts.uploading > 0 ? `${status.counts.uploading} upload(s) in progress` : undefined}
                        />
                        {album.socialCopiesEnabled && (
                          <ZipRow label="Social media" ready={status.zip.socialReady} hint={socialHint} />
                        )}
                      </div>
                    )
                  })()}
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
                        className="text-muted-foreground"
                        onClick={() =>
                          setPhotoSortModeByAlbumId((prev) => ({
                            ...prev,
                            [album.id]: (prev[album.id] || 'alphabetical') === 'alphabetical' ? 'upload-date' : 'alphabetical',
                          }))
                        }
                        title={`Sorted by ${photoSortMode === 'alphabetical' ? 'name' : 'upload date'} — click to change`}
                      >
                        <ArrowUpDown className="w-4 h-4 mr-1.5" />
                        {photoSortMode === 'alphabetical' ? 'A–Z' : 'Upload date'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        onClick={() => void fetchPhotos(album.id)}
                        title="Refresh photos"
                      >
                        <RotateCw className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {photosLoading ? (
                    <p className="text-sm text-muted-foreground">Loading photos…</p>
                  ) : photos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No photos yet</p>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                      {sortedPhotos.map((p) => {
                        const sizeBytes = typeof p.fileSize === 'string' ? Number(p.fileSize) : p.fileSize
                        const isReady = p.status === 'READY'
                        const hasError = p.status === 'ERROR'
                        return (
                          <div
                            key={p.id}
                            className={cn(
                              'group/photo relative aspect-square overflow-hidden rounded-md border bg-muted',
                              hasError && 'border-destructive/60'
                            )}
                          >
                            {/* eslint-disable @next/next/no-img-element */}
                            {p.thumbnailUrl && isReady ? (
                              <img
                                src={p.thumbnailUrl}
                                alt={p.fileName}
                                className="h-full w-full object-cover"
                                loading="lazy"
                                onError={() => {
                                  // Token likely expired — drop the URL so we show the placeholder;
                                  // the next fetchPhotos() re-mints a fresh thumbnail token.
                                  setPhotosByAlbumId((prev) => ({
                                    ...prev,
                                    [album.id]: (prev[album.id] || []).map((x) =>
                                      x.id === p.id ? { ...x, thumbnailUrl: null } : x
                                    ),
                                  }))
                                }}
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center">
                                {hasError ? (
                                  <Images className="w-5 h-5 text-destructive" />
                                ) : isReady ? (
                                  <Images className="w-5 h-5 text-muted-foreground" />
                                ) : (
                                  <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
                                )}
                              </div>
                            )}
                            {/* eslint-enable @next/next/no-img-element */}

                            {/* Filename / size overlay (bottom), revealed on hover */}
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4 opacity-0 transition-opacity group-hover/photo:opacity-100">
                              <p className="truncate text-[11px] font-medium text-white" title={p.fileName}>
                                {p.fileName}
                              </p>
                              <p className="text-[10px] text-white/80">
                                {formatFileSize(sizeBytes)}
                                {!isReady ? ` · ${p.status}` : ''}
                              </p>
                            </div>

                            {hasError && p.error && (
                              <div className="absolute inset-x-0 top-0 truncate bg-destructive/90 px-1.5 py-0.5 text-[10px] text-destructive-foreground" title={p.error}>
                                {p.error}
                              </div>
                            )}

                            {canDelete && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                className="absolute right-1 top-1 h-6 w-6 opacity-0 shadow-sm transition-opacity group-hover/photo:opacity-100 focus-visible:opacity-100"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  void handleDeletePhoto(album.id, p.id, p.fileName)
                                }}
                                title={`Delete ${p.fileName}`}
                              >
                                <Trash2 className="w-3.5 h-3.5 text-destructive" />
                              </Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}

      {!loading && sortedAlbums.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="rounded-full bg-muted p-3">
              <Images className="w-6 h-6 text-muted-foreground" />
            </span>
            <p className="text-sm font-medium">No albums yet</p>
            <p className="text-sm text-muted-foreground">
              {projectStatus === 'APPROVED'
                ? 'This project is approved.'
                : 'Create an album to share photos with your client.'}
            </p>
          </CardContent>
        </Card>
      )}

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
                    setNewAlbumSocialCopies(true)
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

                <div className="grid gap-4 grid-cols-1">
                  <div className="space-y-2">
                    <div className="text-sm font-medium">Allow social media downloads</div>
                    <div className="flex items-center gap-2 h-10">
                      <Checkbox
                        checked={newAlbumSocialCopies}
                        onCheckedChange={(v) => setNewAlbumSocialCopies(Boolean(v))}
                        disabled={creating}
                        aria-label="Allow social media downloads"
                      />
                      <span className={newAlbumSocialCopies ? 'text-sm text-muted-foreground' : 'text-sm text-muted-foreground/70'}>
                        {newAlbumSocialCopies ? 'Social-sized ZIP available for download' : 'Full resolution downloads only'}
                      </span>
                    </div>
                  </div>
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

    <ConfirmDialog
      open={reprocessConfirm !== null}
      onOpenChange={(v) => { if (!v) setReprocessConfirm(null) }}
      title="Reprocess Album?"
      description={`This will re-generate ZIPs, thumbnails, and social copies for "${reprocessConfirm?.name ?? ''}". It runs as a background job — you can track progress in the Running Jobs indicator.`}
      confirmLabel="Reprocess"
      variant="default"
      onConfirm={async () => {
        if (!reprocessConfirm) return
        const albumId = reprocessConfirm.id
        setReprocessConfirm(null)
        await runReprocessAlbum(albumId)
      }}
      onCancel={() => setReprocessConfirm(null)}
    />
    <ConfirmDialog
      open={pendingDisableSocialAlbumId !== null}
      onOpenChange={(v) => { if (!v) setPendingDisableSocialAlbumId(null) }}
      title="Disable Social Media Downloads?"
      description="The social-sized ZIP will be deleted. You can re-enable this later."
      confirmLabel="Disable"
      variant="destructive"
      onConfirm={() => executeSocialToggle(pendingDisableSocialAlbumId!, false)}
      onCancel={() => setPendingDisableSocialAlbumId(null)}
    />
    <ConfirmDialog
      open={pendingDeleteAlbum !== null}
      onOpenChange={(v) => { if (!v) setPendingDeleteAlbum(null) }}
      title={`Delete Album "${pendingDeleteAlbum?.name ?? ''}"?`}
      description="This will delete the album and all its photos. This action cannot be undone."
      confirmLabel="Delete"
      onConfirm={confirmDeleteAlbum}
    />
    <ConfirmDialog
      open={pendingDeletePhoto !== null}
      onOpenChange={(v) => { if (!v) setPendingDeletePhoto(null) }}
      title={`Delete Photo "${pendingDeletePhoto?.fileName ?? ''}"?`}
      description="This action cannot be undone."
      confirmLabel="Delete"
      onConfirm={confirmDeletePhoto}
    />
    <ConfirmDialog
      open={renameConfirmAlbumId !== null}
      onOpenChange={(v) => {
        if (!v) {
          setRenameConfirmAlbumId(null)
          setRenameConfirmAlbumName('')
        }
      }}
      title="Rename Album on S3?"
      description={`Renaming this album to "${renameConfirmAlbumName}" requires copying all photo files to a new S3 location. This will run as a background job — you can track progress in the Running Jobs indicator.`}
      confirmLabel={renameConfirming ? 'Starting…' : 'Start Rename'}
      onConfirm={async () => {
        if (!renameConfirmAlbumId) return
        setRenameConfirming(true)
        try {
          await apiPatch(`/api/albums/${renameConfirmAlbumId}`, { name: renameConfirmAlbumName, confirmed: true })
          setAlbums((prev) => prev.map((a) => (a.id === renameConfirmAlbumId ? { ...a, name: renameConfirmAlbumName } : a)))
          setEditingAlbumId(null)
          setEditAlbumValue('')
          setRenameConfirmAlbumId(null)
          setRenameConfirmAlbumName('')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Failed to start album rename')
        } finally {
          setRenameConfirming(false)
        }
      }}
      onCancel={() => {
        setRenameConfirmAlbumId(null)
        setRenameConfirmAlbumName('')
      }}
    />
  </>
  )
}
