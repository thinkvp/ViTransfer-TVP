'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, Download, Share2 } from 'lucide-react'
import Image from 'next/image'
import { apiFetch } from '@/lib/api-client'
import { paceContentRequest } from '@/lib/download-pacing'
import { GuestAlbumLinkDialog } from '@/components/GuestVideoLinkDialog'

function LazyAlbumThumbnail({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isInView, setIsInView] = useState(false)
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // If IO isn't available for some reason, fall back to eager render.
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsInView(true)
          observer.disconnect()
        }
      },
      { root: null, rootMargin: '200px', threshold: 0.01 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className="relative w-full h-36 sm:h-40">
      {isInView && !imgError ? (
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          className="object-cover"
          loading="lazy"
          onError={() => setImgError(true)}
        />
      ) : (
        <div className="absolute inset-0 bg-muted/30" />
      )}
    </div>
  )
}

type ShareAlbum = {
  id: string
  name: string
  notes: string | null
  socialCopiesEnabled?: boolean
  zip?: {
    fullReady: boolean
    socialReady: boolean
  }
}

type ShareAlbumPhoto = {
  id: string
  fileName: string
  url: string
  thumbnailUrl?: string
  previewUrl?: string
  downloadUrl: string
  socialDownloadUrl: string
  socialReady: boolean
}

type ShareAlbumViewerProps =
  | {
      /** Share page (client or admin preview) for `albumId` within project `shareSlug`. */
      shareSlug: string
      shareToken: string | null
      albumId: string
      /** Admin session: the Share dialog authenticates as the admin rather than with the share token. */
      isAdminView?: boolean
      guestToken?: undefined
      onLoadResult?: undefined
    }
  | {
      /** Public guest album link (/ga/<token>): no share auth, no Share button. */
      guestToken: string
      /** Reports the HTTP status (and payload when OK) of the album load so the page can show expiry/errors. */
      onLoadResult?: (status: number, data: any | null) => void
      shareSlug?: undefined
      shareToken?: undefined
      albumId?: undefined
      isAdminView?: undefined
    }

// Wrapped so the global is never invoked detached from window.
const plainFetch: typeof fetch = (input, init) => fetch(input, init)

const ZIP_POLL_MIN_MS = 5000
const ZIP_POLL_MAX_MS = 30000

export function ShareAlbumViewer(props: ShareAlbumViewerProps) {
  const { shareSlug, shareToken, albumId, guestToken, onLoadResult } = props
  const isGuest = typeof guestToken === 'string'
  const isAdminView = props.isAdminView ?? shareToken === null
  const apiBase = isGuest
    ? `/api/guest-album-links/${encodeURIComponent(guestToken)}`
    : `/api/share/${shareSlug}/albums/${albumId}`
  // Guest pages are public: plain fetch, so a stray admin token is never attached and a
  // 401 can never trigger the admin session-expiry flow.
  const request = isGuest ? plainFetch : apiFetch
  // Share needs an identity the guest-link API accepts (admin session or share JWT). Without
  // one every Generate click would be a 401 POST — and bursts of those trip CrowdSec.
  const canShare = !isGuest && (isAdminView || Boolean(shareToken))
  const onLoadResultRef = useRef(onLoadResult)
  useEffect(() => {
    onLoadResultRef.current = onLoadResult
  }, [onLoadResult])

  const [album, setAlbum] = useState<ShareAlbum | null>(null)
  const [photos, setPhotos] = useState<ShareAlbumPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const zipPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [viewerPhoto, setViewerPhoto] = useState<ShareAlbumPhoto | null>(null)
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  const headers = useMemo(() => {
    const authToken = shareToken
    return authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  }, [shareToken])

  const fetchAlbum = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await request(apiBase, {
        cache: 'no-store',
        headers,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        onLoadResultRef.current?.(res.status, null)
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as any).error || '') : ''
        throw new Error(msg || 'Failed to load album')
      }

      const data = await res.json()
      onLoadResultRef.current?.(res.status, data)
      setAlbum(data.album || null)
      setPhotos(data.photos || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load album')
      setAlbum(null)
      setPhotos([])
    } finally {
      setLoading(false)
    }
  }, [apiBase, headers, request])

  useEffect(() => {
    void fetchAlbum()
  }, [fetchAlbum])

  useEffect(() => {
    return () => {
      if (zipPollTimeoutRef.current) clearTimeout(zipPollTimeoutRef.current)
    }
  }, [])

  // Poll ZIP readiness without refetching the whole album/photos.
  useEffect(() => {
    if (zipPollTimeoutRef.current) {
      clearTimeout(zipPollTimeoutRef.current)
      zipPollTimeoutRef.current = null
    }

    if (loading) return
    if (photos.length === 0) return

    const zip = album?.zip
    if (!zip) return

    if (zip.fullReady && (zip.socialReady || album?.socialCopiesEnabled === false)) return

    // Fixed-URL poll (one CrowdSec bucket entry however often it runs), backing off from 5s
    // to 30s so a tab left open on an album whose ZIP never builds stays cheap.
    let delayMs = ZIP_POLL_MIN_MS
    const tick = async () => {
      try {
        const res = await request(`${apiBase}/zip-status`, {
          cache: 'no-store',
          headers,
        })

        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
          delayMs = 0 // Access is gone; stop polling.
          return
        }
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        const nextFull = Boolean(data?.zip?.fullReady)
        const nextSocial = Boolean(data?.zip?.socialReady)

        setAlbum((prev) => {
          if (!prev) return prev
          const prevZip = prev.zip
          const prevFull = Boolean(prevZip?.fullReady)
          const prevSocial = Boolean(prevZip?.socialReady)
          if (prevFull === nextFull && prevSocial === nextSocial) return prev
          return { ...prev, zip: { fullReady: nextFull, socialReady: nextSocial } }
        })
      } catch {
        // ignore
      } finally {
        if (delayMs > 0) {
          zipPollTimeoutRef.current = setTimeout(() => {
            void tick()
          }, delayMs)
          delayMs = Math.min(ZIP_POLL_MAX_MS, Math.round(delayMs * 1.5))
        }
      }
    }

    void tick()

    return () => {
      if (zipPollTimeoutRef.current) {
        clearTimeout(zipPollTimeoutRef.current)
        zipPollTimeoutRef.current = null
      }
    }
  }, [album?.zip, album?.socialCopiesEnabled, apiBase, headers, loading, photos.length, request])

  const requestZip = async (variant: 'full' | 'social') => {
    try {
      const res = await request(`${apiBase}/download-zip-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(headers || {}),
        },
        body: JSON.stringify({ variant }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as any).error || '') : ''
        throw new Error(msg || 'Failed to start download')
      }

      const data = await res.json()
      if (data?.url) {
        await triggerDownload(data.url)
      } else if (res.status === 202) {
        setError('The archive is still being prepared. Please try again in a moment.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    }
  }

  // Every download is a distinct one-off content URL; pace them so rapid clicks can never
  // overflow CrowdSec's distinct-path bucket (see download-pacing.ts).
  const triggerDownload = async (url: string) => {
    await paceContentRequest()
    const link = document.createElement('a')
    link.href = url
    link.rel = 'noopener'
    link.download = ''
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const viewerIndex = useMemo(() => {
    if (!viewerPhoto) return -1
    return photos.findIndex((p) => p.id === viewerPhoto.id)
  }, [photos, viewerPhoto])

  const goPrevPhoto = useCallback(() => {
    if (!viewerPhoto) return
    if (viewerIndex <= 0) return
    const prev = photos[viewerIndex - 1]
    if (prev) setViewerPhoto(prev)
  }, [photos, viewerIndex, viewerPhoto])

  const goNextPhoto = useCallback(() => {
    if (!viewerPhoto) return
    if (viewerIndex < 0 || viewerIndex >= photos.length - 1) return
    const next = photos[viewerIndex + 1]
    if (next) setViewerPhoto(next)
  }, [photos, viewerIndex, viewerPhoto])

  useEffect(() => {
    if (!viewerPhoto) return

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const isTypingContext =
        tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable)
      if (isTypingContext) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrevPhoto()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNextPhoto()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goNextPhoto, goPrevPhoto, viewerPhoto])

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold truncate">{album?.name || 'Album'}</h2>
          {album?.notes && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap wrap-break-word">{album.notes}</p>}
        </div>
        {canShare && album ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 self-start sm:self-auto"
            onClick={() => setShareOpen(true)}
            title="Share a guest link to this album"
          >
            <Share2 className="h-4 w-4" />
            Share
          </Button>
        ) : null}
      </div>

      {canShare ? (
        <GuestAlbumLinkDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          albumId={albumId}
          isAdminView={isAdminView}
          shareToken={shareToken}
        />
      ) : null}

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex-1 min-h-0 border border-border rounded-lg bg-card flex items-center justify-center">
          <p className="text-muted-foreground">Loading album…</p>
        </div>
      ) : photos.length === 0 ? (
        <div className="flex-1 min-h-0 border border-border rounded-lg bg-card flex items-center justify-center">
          <p className="text-muted-foreground">No photos available</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg bg-card overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="px-6 py-4 border-b border-border flex items-center gap-3">
            <div className="text-base font-semibold">
              {photos.length} photo{photos.length === 1 ? '' : 's'}
            </div>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <Button
                type="button"
                variant="default"
                onClick={() => { setError(null); setShowDownloadModal(true) }}
                disabled={photos.length === 0}
                className="whitespace-nowrap"
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </Button>
            </div>
          </div>

          <div className="pb-6 flex-1 min-h-0 overflow-y-auto px-6 pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
              {photos.map((p) => {
                return (
                  <div
                    key={p.id}
                    className={cn(
                      'group relative rounded-lg overflow-hidden border bg-muted/20',
                      'focus:outline-none focus:ring-2 focus:ring-primary/40',
                      'hover:border-primary/30'
                    )}
                    title="Click to view"
                  >
                    <button
                      type="button"
                      onClick={() => setViewerPhoto(p)}
                      className="block w-full text-left"
                      title="Click to view"
                    >
                      <div className="relative w-full h-36 sm:h-40">
                        <LazyAlbumThumbnail src={p.thumbnailUrl || p.previewUrl || p.url} alt={p.fileName} />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 bg-background/80 backdrop-blur-sm px-2 py-1">
                        <p className="text-xs truncate">{p.fileName}</p>
                      </div>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <Dialog open={!!viewerPhoto} onOpenChange={(open) => !open && setViewerPhoto(null)}>
        <DialogContent className="max-w-none w-[95vw] h-[95vh] flex flex-col">
          <DialogHeader>
            {/* pr-9 keeps the title clear of the dialog's absolutely positioned close button */}
            <DialogTitle className="truncate pr-9">{viewerPhoto?.fileName || 'Photo'}</DialogTitle>
          </DialogHeader>
          {viewerPhoto && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  This is a low resolution preview. Use the buttons to download the original versions.
                </p>
                <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center sm:gap-2 sm:shrink-0">
                  {album?.socialCopiesEnabled !== false && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void triggerDownload(viewerPhoto.socialDownloadUrl)}
                      disabled={!viewerPhoto.socialReady}
                      className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download Social Media Sized
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => void triggerDownload(viewerPhoto.downloadUrl)}
                    className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download Full Resolution
                  </Button>
                </div>
              </div>

              <div className="rounded-lg overflow-hidden border bg-muted/20">
                <div className="relative w-full h-[80dvh] group">
                  <Image
                    src={viewerPhoto.previewUrl || viewerPhoto.url}
                    alt={viewerPhoto.fileName}
                    fill
                    unoptimized
                    className="object-contain"
                    priority
                    onContextMenu={(e) => e.preventDefault()}
                  />

                  {viewerIndex > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={goPrevPhoto}
                      aria-label="Previous photo"
                      className={cn(
                        'absolute left-2 top-1/2 -translate-y-1/2',
                        'h-10 w-10 rounded-full',
                        'bg-background/60 hover:bg-background/80 backdrop-blur-sm',
                        'opacity-0 pointer-events-none',
                        'group-hover:opacity-100 group-hover:pointer-events-auto',
                        'focus-visible:opacity-100 focus-visible:pointer-events-auto'
                      )}
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </Button>
                  )}

                  {viewerIndex >= 0 && viewerIndex < photos.length - 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={goNextPhoto}
                      aria-label="Next photo"
                      className={cn(
                        'absolute right-2 top-1/2 -translate-y-1/2',
                        'h-10 w-10 rounded-full',
                        'bg-background/60 hover:bg-background/80 backdrop-blur-sm',
                        'opacity-0 pointer-events-none',
                        'group-hover:opacity-100 group-hover:pointer-events-auto',
                        'focus-visible:opacity-100 focus-visible:pointer-events-auto'
                      )}
                    >
                      <ChevronRight className="h-5 w-5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Album ZIP download modal */}
      <Dialog
        open={showDownloadModal}
        onOpenChange={(open) => {
          setShowDownloadModal(open)
          if (!open) setError(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Download Options</DialogTitle>
            {album?.name && <DialogDescription>{album.name}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {/* Download items */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void requestZip('full')}
                disabled={!album?.zip?.fullReady || photos.length === 0}
                className={`w-full p-4 border-2 border-border rounded-lg text-left transition-colors ${
                  !album?.zip?.fullReady || photos.length === 0
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:border-primary cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Download className="h-5 w-5" />
                  </span>
                  <div className="flex-1">
                    <p className="font-medium">Full Resolution Photos</p>
                    <p className="text-sm text-muted-foreground">
                      {album?.zip?.fullReady ? 'Download the full resolution photo archive' : 'Preparing archive…'}
                    </p>
                  </div>
                </div>
              </button>

              {album?.socialCopiesEnabled !== false && (
                <button
                  type="button"
                  onClick={() => void requestZip('social')}
                  disabled={!album?.zip?.socialReady || photos.length === 0}
                  className={`w-full p-4 border-2 border-border rounded-lg text-left transition-colors ${
                    !album?.zip?.socialReady || photos.length === 0
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:border-primary cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <Download className="h-5 w-5" />
                    </span>
                    <div className="flex-1">
                      <p className="font-medium">Social Media Sized Photos</p>
                      <p className="text-sm text-muted-foreground">
                        {album?.zip?.socialReady ? 'Smaller photos optimized for social media sharing' : 'Preparing archive…'}
                      </p>
                    </div>
                  </div>
                </button>
              )}
            </div>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive rounded-md">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
