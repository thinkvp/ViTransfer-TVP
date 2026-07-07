'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  FileIcon,
  FileImage,
  FileVideo,
  FilePlay,
  FileMusic,
  FileText,
  File,
  FileArchive,
  ImagePlay,
  Trash2,
  Loader2,
  Copy,
  Captions,
} from 'lucide-react'
import { Button } from './ui/button'
import { formatFileSize } from '@/lib/utils'
import { apiFetch, apiDelete, apiPost } from '@/lib/api-client'
import { AssetCopyMoveModal } from './AssetCopyMoveModal'
import { withDownloadTracking } from '@/lib/download-url'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { toast } from 'sonner'

interface VideoAsset {
  id: string
  fileName: string
  fileSize: string
  fileType: string
  category: string | null
  createdAt: string
  thumbnailUrl?: string | null
}

interface VideoAssetListProps {
  videoId: string
  videoName: string
  versionLabel: string
  projectId: string
  canManage?: boolean
  onAssetDeleted?: () => void
  refreshTrigger?: number // Used to trigger refetch from parent
}

export function VideoAssetList({
  videoId,
  videoName,
  versionLabel,
  projectId,
  canManage = true,
  onAssetDeleted,
  refreshTrigger,
}: VideoAssetListProps) {
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [settingThumbnail, setSettingThumbnail] = useState<string | null>(null)
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentThumbnailPath, setCurrentThumbnailPath] = useState<string | null>(null)
  const [pendingDeleteAsset, setPendingDeleteAsset] = useState<{ id: string; name: string } | null>(null)
  const [pendingThumbnailAsset, setPendingThumbnailAsset] = useState<{ id: string; name: string; action: 'set' | 'remove'; message: string } | null>(null)
  const [settingSubtitles, setSettingSubtitles] = useState<string | null>(null)
  const [pendingSubtitlesAsset, setPendingSubtitlesAsset] = useState<{ id: string; name: string; message: string } | null>(null)

  const fetchAssets = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await apiFetch(`/api/videos/${videoId}/assets`)

      if (!response.ok) {
        throw new Error('Failed to fetch assets')
      }

      const data = await response.json()
      setAssets(data.assets || [])
      setCurrentThumbnailPath(data.currentThumbnailPath || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets')
    } finally {
      setLoading(false)
    }
  }, [videoId])

  useEffect(() => {
    fetchAssets()
  }, [fetchAssets, refreshTrigger])

  const handleDelete = (assetId: string, fileName: string) => {
    if (!canManage) return
    setPendingDeleteAsset({ id: assetId, name: fileName })
  }

  const confirmDeleteAsset = () => {
    const { id: assetId, name: fileName } = pendingDeleteAsset!
    setPendingDeleteAsset(null)
    setDeletingId(assetId)

    // Optimistically remove from UI
    const previousAssets = assets
    setAssets(assets.filter(a => a.id !== assetId))

    // Delete in background without blocking UI
    apiDelete(`/api/videos/${videoId}/assets/${assetId}`)
      .then(() => {
        if (onAssetDeleted) {
          onAssetDeleted()
        }
      })
      .catch(() => {
        setAssets(previousAssets)
        toast.error('Failed to delete asset')
      })
      .finally(() => {
        setDeletingId(null)
      })
  }

  const getCategoryLabel = (category: string | null) => {
    if (!category) return 'Other'
    return category.charAt(0).toUpperCase() + category.slice(1)
  }

  const canSetAsThumbnail = (asset: VideoAsset) => {
    const fileType = asset.fileType?.toLowerCase() || ''
    const fileName = asset.fileName.toLowerCase()
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : ''

    // Align with API requirements: only JPG/PNG assets can become thumbnails
    const allowedThumbnailMimeTypes = ['image/jpeg', 'image/png', 'image/jpg']
    const allowedThumbnailExtensions = ['.jpg', '.jpeg', '.png']

    return allowedThumbnailMimeTypes.includes(fileType) || allowedThumbnailExtensions.includes(ext)
  }

  // An .srt asset can be promoted to the video's active playback subtitles.
  const canSetSubtitles = (asset: VideoAsset) => {
    const fileName = asset.fileName.toLowerCase()
    const cat = asset.category?.toLowerCase() || ''
    return fileName.endsWith('.srt') || cat === 'subtitle' || cat === 'subtitles'
  }

  // The canonical playback subtitles asset is the one with category 'subtitles'.
  const isActiveSubtitles = (asset: VideoAsset) => asset.category === 'subtitles'

  const formatFileSizeBigInt = (bytes: string) => {
    return formatFileSize(Number(bytes))
  }

  const getAssetIcon = (asset: VideoAsset) => {
    const fileType = asset.fileType?.toLowerCase() || ''
    const fileName = asset.fileName.toLowerCase()
    const category = asset.category?.toLowerCase() || ''

    if (category === 'thumbnail' || fileType.startsWith('image/')) {
      return <FileImage className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    if (category === 'project') {
      return <FilePlay className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    if (fileType.startsWith('video/')) {
      return <FileVideo className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    if (fileType.startsWith('audio/')) {
      return <FileMusic className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    if (
      fileType === 'application/zip' ||
      fileType === 'application/x-zip-compressed' ||
      fileName.endsWith('.zip')
    ) {
      return <FileArchive className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    if (
      category === 'caption' ||
      fileName.endsWith('.srt') ||
      fileName.endsWith('.vtt') ||
      fileName.endsWith('.txt') ||
      fileName.endsWith('.md')
    ) {
      return <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
    }

    return <File className="h-5 w-5 text-muted-foreground shrink-0" />
  }

  const triggerDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = withDownloadTracking(url)
    link.download = ''
    link.rel = 'noopener'
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handleDownload = async (assetId: string, fileName: string) => {
    // Generate download token in background without blocking UI
    apiFetch(`/api/videos/${videoId}/assets/${assetId}/download-token`, {
      method: 'POST'
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to generate download link')
        }
        return response.json()
      })
      .then(({ url }) => {
        triggerDownload(url)
      })
      .catch((err) => {
        toast.error('Failed to download asset')
      })
  }

  const handleSetThumbnail = (assetId: string, fileName: string) => {
    if (!canManage) return
    const asset = assets.find(a => a.id === assetId)
    const isCurrent = asset ? isCurrentThumbnail(asset) : false
    const action = isCurrent ? 'remove' : 'set'
    const message = isCurrent
      ? `Remove "${fileName}" as the video thumbnail? The system-generated thumbnail will be used instead.`
      : `Set "${fileName}" as the video thumbnail?`
    setPendingThumbnailAsset({ id: assetId, name: fileName, action, message })
  }

  const confirmSetThumbnail = () => {
    const { id: assetId, action } = pendingThumbnailAsset!
    setPendingThumbnailAsset(null)
    setSettingThumbnail(assetId)

    apiPost(`/api/videos/${videoId}/assets/${assetId}/set-thumbnail`, { action })
      .then(() => fetchAssets())
      .then(() => {
        if (onAssetDeleted) {
          onAssetDeleted()
        }
      })
      .catch(() => {
        toast.error(`Failed to ${action} thumbnail`)
      })
      .finally(() => {
        setSettingThumbnail(null)
      })
  }

  const isCurrentThumbnail = (asset: VideoAsset) => {
    if (!currentThumbnailPath) return false
    return currentThumbnailPath.includes(asset.id) || currentThumbnailPath.includes(asset.fileName)
  }

  // Promote an uploaded .srt asset to be this version's active playback subtitles
  // (parallels "Set as thumbnail"). Upload the SRT like any other asset, then Set it.
  const handleSetSubtitles = (assetId: string, fileName: string) => {
    if (!canManage) return
    const asset = assets.find((a) => a.id === assetId)
    if (!asset || isActiveSubtitles(asset)) return
    const hasActive = assets.some((a) => a.category === 'subtitles')
    const message = hasActive
      ? `Set "${fileName}" as this version's subtitles? This replaces the current captions (the previous file is kept as an asset).`
      : `Set "${fileName}" as this version's subtitles?`
    setPendingSubtitlesAsset({ id: assetId, name: fileName, message })
  }

  const confirmSetSubtitles = () => {
    const { id: assetId } = pendingSubtitlesAsset!
    setPendingSubtitlesAsset(null)
    setSettingSubtitles(assetId)

    apiPost(`/api/videos/${videoId}/assets/${assetId}/set-subtitles`, {})
      .then((res: any) => {
        toast.success(`Subtitles set${res?.cueCount ? ` (${res.cueCount} cues)` : ''}`)
        return fetchAssets()
      })
      .then(() => { if (onAssetDeleted) onAssetDeleted() })
      .catch((e: any) => toast.error(e?.message || 'Failed to set subtitles'))
      .finally(() => setSettingSubtitles(null))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md bg-destructive/10 border border-destructive px-4 py-3 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (assets.length === 0) {
    return null
  }

  return (
    <>
      <div className="mt-4 pt-4 border-t">
      <div className="space-y-2">
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="text-sm font-medium text-muted-foreground">
            Uploaded Assets ({assets.length})
          </div>
          {canManage && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowCopyModal(true)}
            >
              <Copy className="h-4 w-4 mr-2" />
              Copy to Version
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {assets.map((asset) => (
            <div
              key={asset.id}
              className="flex items-center gap-3 rounded-md border bg-card p-2 transition-colors hover:bg-accent/50"
            >
              {asset.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={asset.thumbnailUrl}
                  alt={asset.fileName}
                  className="h-10 w-10 shrink-0 rounded border bg-muted object-cover"
                  loading="lazy"
                  onError={() => {
                    // Token likely expired — drop the URL so we show the file-type icon;
                    // the next fetchAssets() re-mints a fresh preview token.
                    setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, thumbnailUrl: null } : a)))
                  }}
                />
              ) : (
                getAssetIcon(asset)
              )}
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => handleDownload(asset.id, asset.fileName)}
                  className="text-sm font-medium truncate text-left text-foreground hover:underline"
                  title={`Download ${asset.fileName}`}
                >
                  {asset.fileName}
                </button>
                <div className="flex gap-3 text-xs text-muted-foreground">
                  <span>{formatFileSizeBigInt(asset.fileSize)}</span>
                  <span>•</span>
                  <span>{getCategoryLabel(asset.category)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {canManage && canSetSubtitles(asset) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleSetSubtitles(asset.id, asset.fileName)}
                    disabled={settingSubtitles === asset.id}
                    title={isActiveSubtitles(asset) ? "Active playback subtitles" : "Set as the video's subtitles"}
                  >
                    {settingSubtitles === asset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Captions className={`h-4 w-4 ${isActiveSubtitles(asset) ? 'text-green-600' : ''}`} />
                    )}
                  </Button>
                )}
                {canManage && canSetAsThumbnail(asset) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleSetThumbnail(asset.id, asset.fileName)}
                    disabled={settingThumbnail === asset.id}
                    title={isCurrentThumbnail(asset) ? "Remove custom thumbnail (revert to system-generated)" : "Set as video thumbnail"}
                  >
                    {settingThumbnail === asset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlay className={`h-4 w-4 ${isCurrentThumbnail(asset) ? 'text-green-600' : ''}`} />
                    )}
                  </Button>
                )}
                {canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(asset.id, asset.fileName)}
                    disabled={deletingId === asset.id}
                    title="Delete asset"
                  >
                    {deletingId === asset.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-destructive" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <AssetCopyMoveModal
        currentVideoId={videoId}
        currentVideoName={videoName}
        currentVersionLabel={versionLabel}
        projectId={projectId}
        isOpen={showCopyModal}
        onClose={() => setShowCopyModal(false)}
        onComplete={() => {
          setShowCopyModal(false)
          if (onAssetDeleted) {
            onAssetDeleted()
          }
        }}
      />
      </div>

      <ConfirmDialog
        open={pendingDeleteAsset !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteAsset(null) }}
        title={`Delete Asset "${pendingDeleteAsset?.name ?? ''}"?`}
        description="This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteAsset}
      />
      <ConfirmDialog
        open={pendingThumbnailAsset !== null}
        onOpenChange={(v) => { if (!v) setPendingThumbnailAsset(null) }}
        title={pendingThumbnailAsset?.action === 'remove' ? 'Remove Thumbnail' : 'Set Thumbnail'}
        description={pendingThumbnailAsset?.message}
        confirmLabel={pendingThumbnailAsset?.action === 'remove' ? 'Remove' : 'Set'}
        variant="default"
        onConfirm={confirmSetThumbnail}
      />
      <ConfirmDialog
        open={pendingSubtitlesAsset !== null}
        onOpenChange={(v) => { if (!v) setPendingSubtitlesAsset(null) }}
        title="Set subtitles"
        description={pendingSubtitlesAsset?.message}
        confirmLabel="Set"
        variant="default"
        onConfirm={confirmSetSubtitles}
      />
    </>
  )
}
