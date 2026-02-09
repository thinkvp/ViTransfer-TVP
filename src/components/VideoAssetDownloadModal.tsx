'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X, Download, FileIcon, Loader2, CheckCircle, FileVideo, Image, Music, FileText, FileArchive } from 'lucide-react'
import { Button } from './ui/button'
import { formatFileSize } from '@/lib/utils'
import { getAccessToken } from '@/lib/token-store'

interface VideoAsset {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
}

interface VideoAssetDownloadModalProps {
  videoId: string
  videoName: string
  versionLabel: string
  onClose: () => void
  isOpen: boolean
  shareToken?: string | null
  isAdmin?: boolean
}

export function VideoAssetDownloadModal({
  videoId,
  videoName,
  versionLabel,
  onClose,
  isOpen,
  shareToken = null,
  isAdmin = false,
}: VideoAssetDownloadModalProps) {
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloadedVideo, setDownloadedVideo] = useState(false)
  const [downloadedAssets, setDownloadedAssets] = useState<Record<string, boolean>>({})

  const downloadStateKey = useMemo(() => {
    return `download-modal:${videoId}:${versionLabel}`
  }, [videoId, versionLabel])

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      if (!isAdmin && !shareToken) {
        setAssets([])
        setError('Authentication required')
        return
      }

      const headers = buildAuthHeaders(shareToken, isAdmin)
      const response = await fetch(`/api/videos/${videoId}/assets`, {
        headers,
      })
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        let details = ''
        try {
          const parsed = bodyText ? JSON.parse(bodyText) : null
          if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            details = String((parsed as any).error || '')
          }
        } catch {
          // ignore
        }

        const statusHint = `HTTP ${response.status}`
        throw new Error(details ? `${details} (${statusHint})` : `Failed to fetch assets (${statusHint})`)
      }

      const data = await response.json()
      setAssets(data.assets)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets')
    } finally {
      setLoading(false)
    }
  }, [videoId, shareToken, isAdmin])

  useEffect(() => {
    if (isOpen) {
      fetchAssets()
    }
  }, [isOpen, fetchAssets])

  useEffect(() => {
    if (!isOpen) return
    try {
      const stored = sessionStorage.getItem(downloadStateKey)
      if (!stored) {
        setDownloadedVideo(false)
        setDownloadedAssets({})
        return
      }

      const parsed = JSON.parse(stored) as {
        video?: boolean
        assets?: Record<string, boolean>
      }
      setDownloadedVideo(Boolean(parsed.video))
      setDownloadedAssets(parsed.assets || {})
    } catch {
      setDownloadedVideo(false)
      setDownloadedAssets({})
    }
  }, [isOpen, downloadStateKey])


  const persistDownloadState = (nextVideo: boolean, nextAssets: Record<string, boolean>) => {
    setDownloadedVideo(nextVideo)
    setDownloadedAssets(nextAssets)
    try {
      sessionStorage.setItem(downloadStateKey, JSON.stringify({
        video: nextVideo,
        assets: nextAssets,
      }))
    } catch {
      // ignore
    }
  }

  const downloadSingleAsset = async (assetId: string) => {
    try {
      setError(null)

      // Use token-based download for everyone (instant, no memory loading)
      const response = await fetch(`/api/videos/${videoId}/assets/${assetId}/download-token`, {
        method: 'POST',
        headers: buildAuthHeaders(shareToken, isAdmin),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to generate download link' }))
        throw new Error(data.error || 'Failed to generate download link')
      }

      const { url: downloadUrl } = await response.json()
      triggerDownload(downloadUrl)
      persistDownloadState(downloadedVideo, {
        ...downloadedAssets,
        [assetId]: true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }

  const downloadVideoOnly = async () => {
    try {
      setError(null)

      // Use token-based download for everyone (instant, no memory loading)
      const response = await fetch(`/api/videos/${videoId}/download-token`, {
        method: 'POST',
        headers: buildAuthHeaders(shareToken, isAdmin),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to generate download link' }))
        throw new Error(data.error || 'Failed to generate download link')
      }

      const { url: downloadUrl } = await response.json()
      triggerDownload(downloadUrl)
      persistDownloadState(true, downloadedAssets)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }


  const formatFileSizeBigInt = (bytes: string) => {
    return formatFileSize(Number(bytes))
  }

  const getCategoryLabel = (category: string | null) => {
    if (!category) return 'Other'
    return category.charAt(0).toUpperCase() + category.slice(1)
  }

  const getAssetIcon = (asset: VideoAsset) => {
    if (asset.category === 'image' || asset.fileType.startsWith('image/')) return Image
    if (asset.category === 'audio' || asset.fileType.startsWith('audio/')) return Music
    if (asset.fileType.startsWith('video/')) return FileVideo
    if (asset.fileType === 'application/pdf') return FileText
    if (asset.fileType.includes('zip') || asset.fileType.includes('compressed')) return FileArchive
    return FileIcon
  }

  const triggerDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = url
    link.download = ''
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (!isOpen) return null

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[2147483646] bg-black/40 backdrop-blur-[1px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[2147483647] w-[calc(100vw-2rem)] max-w-3xl max-h-[90vh] -translate-x-1/2 -translate-y-1/2 bg-background dark:bg-card border border-border rounded-lg flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b border-border">
            <div>
              <DialogPrimitive.Title asChild>
                <h2 className="text-xl font-bold">Download Options</h2>
              </DialogPrimitive.Title>
              <DialogPrimitive.Description asChild>
                <p className="text-sm text-muted-foreground mt-1">
                  {videoName} - {versionLabel}
                </p>
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon">
                <X className="h-5 w-5" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Quick actions */}
          <div className="space-y-3">
            <button
              onClick={downloadVideoOnly}
              className="w-full p-4 border-2 border-border rounded-lg hover:border-primary transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Download className="h-5 w-5" />
                </span>
                <div className="flex-1">
                  <p className="font-medium">Download Video</p>
                  <p className="text-sm text-muted-foreground">
                    Download the approved video file
                  </p>
                </div>
                {downloadedVideo && (
                  <CheckCircle className="h-5 w-5 text-green-600" aria-hidden="true" />
                )}
              </div>
            </button>
          </div>

          {/* Assets section */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : assets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No additional assets available for this video
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-sm">
                  Additional Assets ({assets.length})
                </h3>
              </div>

              <div className="space-y-2">
                {assets.map((asset) => {
                  const AssetIcon = getAssetIcon(asset)
                  const isDownloaded = Boolean(downloadedAssets[asset.id])
                  return (
                  <div
                    key={asset.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => downloadSingleAsset(asset.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        downloadSingleAsset(asset.id)
                      }
                    }}
                    className="flex items-center gap-3 p-3 border border-border rounded-lg hover:bg-accent/50 transition-colors cursor-pointer"
                    aria-label={`Download ${asset.fileName}`}
                  >
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <AssetIcon className="h-5 w-5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{asset.fileName}</p>
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        <span>{formatFileSizeBigInt(asset.fileSize)}</span>
                        <span>•</span>
                        <span>{getCategoryLabel(asset.category)}</span>
                      </div>
                    </div>
                    {isDownloaded && (
                      <CheckCircle className="h-5 w-5 text-green-600" aria-hidden="true" />
                    )}
                  </div>
                )})}
              </div>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive rounded-md text-destructive text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border">
          <Button
            variant="outline"
            onClick={onClose}
            className="w-full"
          >
            Close
          </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function buildAuthHeaders(shareToken?: string | null, isAdmin?: boolean) {
  const headers: Record<string, string> = {}
  const token = shareToken || (isAdmin ? getAccessToken() : null)
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}
