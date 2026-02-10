'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import Image from 'next/image'
import ThemeToggle from '@/components/ThemeToggle'
import { apiFetch } from '@/lib/api-client'

function LazyAlbumThumbnail({ src, alt }: { src: string; alt: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isInView, setIsInView] = useState(false)

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
      {isInView ? (
        <Image
          src={src}
          alt={alt}
          fill
          sizes="(min-width: 1536px) 12vw, (min-width: 1280px) 16vw, (min-width: 1024px) 20vw, (min-width: 640px) 33vw, 50vw"
          className="object-cover"
          loading="lazy"
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
  zip?: {
    fullReady: boolean
    socialReady: boolean
  }
}

type ShareAlbumPhoto = {
  id: string
  fileName: string
  url: string
  downloadUrl: string
  socialDownloadUrl: string
  socialReady: boolean
}

export function ShareAlbumViewer({
  shareSlug,
  shareToken,
  albumId,
  showThemeToggle = false,
}: {
  shareSlug: string
  shareToken: string | null
  albumId: string
  showThemeToggle?: boolean
}) {
  const [album, setAlbum] = useState<ShareAlbum | null>(null)
  const [photos, setPhotos] = useState<ShareAlbumPhoto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const zipPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [viewerPhoto, setViewerPhoto] = useState<ShareAlbumPhoto | null>(null)

  const headers = useMemo(() => {
    const authToken = shareToken
    return authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  }, [shareToken])

  const fetchAlbum = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/share/${shareSlug}/albums/${albumId}`, {
        cache: 'no-store',
        headers,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        const msg = data && typeof data === 'object' && 'error' in data ? String((data as any).error || '') : ''
        throw new Error(msg || 'Failed to load album')
      }

      const data = await res.json()
      setAlbum(data.album || null)
      setPhotos(data.photos || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load album')
      setAlbum(null)
      setPhotos([])
    } finally {
      setLoading(false)
    }
  }, [albumId, headers, shareSlug])

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

    if (zip.fullReady && zip.socialReady) return

    const tick = async () => {
      try {
        const res = await apiFetch(`/api/share/${shareSlug}/albums/${albumId}/zip-status`, {
          cache: 'no-store',
          headers,
        })

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
        zipPollTimeoutRef.current = setTimeout(() => {
          void tick()
        }, 5000)
      }
    }

    void tick()

    return () => {
      if (zipPollTimeoutRef.current) {
        clearTimeout(zipPollTimeoutRef.current)
        zipPollTimeoutRef.current = null
      }
    }
  }, [album?.zip, albumId, headers, loading, photos.length, shareSlug])

  const requestZip = async (variant: 'full' | 'social') => {
    try {
      const res = await apiFetch(`/api/share/${shareSlug}/albums/${albumId}/download-zip-token`, {
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
        triggerDownload(data.url)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    }
  }

  const triggerDownload = (url: string) => {
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
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold truncate">{album?.name || 'Album'}</h2>
          {album?.notes && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap break-words">{album.notes}</p>}
        </div>

        <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center sm:gap-2 sm:flex-shrink-0">
          {showThemeToggle && <ThemeToggle />}
          <Button
            type="button"
            variant="outline"
            onClick={() => void requestZip('social')}
            disabled={photos.length === 0 || !album?.zip?.socialReady}
            className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Social Media Sized
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void requestZip('full')}
            disabled={photos.length === 0 || !album?.zip?.fullReady}
            className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
          >
            <Download className="w-4 h-4 mr-2" />
            Download Full Resolution
          </Button>
        </div>
      </div>

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
          <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-3">
            <div className="text-base font-semibold">
              {photos.length} photo{photos.length === 1 ? '' : 's'}
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
                        <LazyAlbumThumbnail src={p.url} alt={p.fileName} />
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
            <DialogTitle className="truncate">{viewerPhoto?.fileName || 'Photo'}</DialogTitle>
          </DialogHeader>
          {viewerPhoto && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  This is a low resolution preview. Use the buttons to download the original versions.
                </p>
                <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center sm:gap-2 sm:shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => triggerDownload(viewerPhoto.socialDownloadUrl)}
                    disabled={!viewerPhoto.socialReady}
                    className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Download Social Media Sized
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => triggerDownload(viewerPhoto.downloadUrl)}
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
                    src={viewerPhoto.url}
                    alt={viewerPhoto.fileName}
                    fill
                    sizes="(min-width: 1024px) 1024px, 100vw"
                    className="object-contain"
                    priority
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
    </div>
  )
}
