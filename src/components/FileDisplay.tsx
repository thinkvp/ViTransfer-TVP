'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DocumentViewerModal } from '@/components/DocumentViewerModal'
import { canPreviewFile, getPreviewExtension, getPreviewMode } from '@/lib/document-preview'
import {
  Trash2,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
} from 'lucide-react'

/**
 * Above this, an image attachment shows a tinted icon tile instead of a thumbnail.
 *
 * There is no generated thumbnail for comment attachments, so a preview means fetching the
 * original — a client attaching several phone photos would otherwise pull tens of megabytes
 * into the thread just to draw 34px squares. Resizing server-side was the alternative and
 * was rejected: it would route every image through the app, which is the round-trip the
 * whole viewer is built to avoid.
 */
const IMAGE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

/**
 * Tile treatment per file type. Colour is a recognition aid, not status, so it stays in the
 * muted /15 tint the rest of the app uses for categorical fills; anything unrecognised falls
 * back to neutral rather than inventing another hue.
 */
function getFileTypeTile(fileName: string): { Icon: typeof FileIcon; className: string } {
  switch (getPreviewExtension(fileName)) {
    case 'pdf':
      return { Icon: FileText, className: 'bg-red-500/15 text-red-400' }
    case 'doc':
    case 'docx':
    case 'rtf':
    case 'odt':
      return { Icon: FileText, className: 'bg-blue-500/15 text-blue-400' }
    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'csv':
    case 'tsv':
      return { Icon: FileSpreadsheet, className: 'bg-green-500/15 text-green-400' }
    case 'ppt':
    case 'pptx':
      return { Icon: Presentation, className: 'bg-orange-500/15 text-orange-400' }
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'avif':
    case 'heic':
    case 'heif':
    case 'tif':
    case 'tiff':
    case 'svg':
    case 'psd':
      return { Icon: FileImage, className: 'bg-purple-500/15 text-purple-400' }
    case 'mp4':
    case 'mov':
    case 'm4v':
    case 'webm':
    case 'mkv':
    case 'avi':
    case 'mxf':
      return { Icon: FileVideo, className: 'bg-purple-500/15 text-purple-400' }
    case 'mp3':
    case 'wav':
    case 'aac':
    case 'flac':
    case 'ogg':
    case 'm4a':
    case 'aiff':
      return { Icon: FileAudio, className: 'bg-amber-500/15 text-amber-400' }
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
      return { Icon: FileArchive, className: 'bg-amber-500/15 text-amber-400' }
    default:
      return { Icon: FileIcon, className: 'bg-muted text-muted-foreground' }
  }
}

interface AttachedFileDisplayProps {
  fileName: string
  fileSize: number
  onRemove?: () => void
  isLoading?: boolean
}

export function AttachedFileDisplay({
  fileName,
  fileSize,
  onRemove,
  isLoading = false,
}: AttachedFileDisplayProps) {
  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  return (
    <div className="flex items-center gap-2 p-2 bg-muted rounded-lg text-sm">
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{fileName}</p>
        <p className="text-xs text-muted-foreground">{formatFileSize(fileSize)}</p>
      </div>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={isLoading}
          className="h-8 w-8 p-0 hover:bg-destructive/10"
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      )}
    </div>
  )
}

interface CommentFileDisplayProps {
  fileId: string
  fileName: string
  fileSize: number
  commentId: string
  onDownload?: (fileId: string) => Promise<void>
  isLoading?: boolean
  /**
   * The other attachments on the same comment, so the viewer can page through them.
   * Optional: without it the viewer opens on this file alone.
   */
  siblings?: Array<{ id: string; fileName: string; fileSize: number }>
  /**
   * Authenticated fetch for the attachment bytes. Comment attachments are reachable with
   * either an admin bearer token or a share token depending on where the thread is being
   * read, so the caller owns that choice. Without it the file is download-only.
   */
  onFetchFile?: (url: string) => Promise<Response>
}

export function CommentFileDisplay({
  fileId,
  fileName,
  fileSize,
  commentId,
  onDownload,
  isLoading = false,
  siblings,
  onFetchFile,
}: CommentFileDisplayProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  const viewerFiles = (siblings && siblings.length > 0)
    ? siblings
    : [{ id: fileId, fileName, fileSize }]
  const ownIndex = Math.max(0, viewerFiles.findIndex((f) => f.id === fileId))
  const canView = Boolean(onFetchFile) && canPreviewFile(fileName)

  const extension = getPreviewExtension(fileName)
  const { Icon: TypeIcon, className: tileClassName } = getFileTypeTile(fileName)
  // getPreviewMode is the authoritative "the browser can render this as an image" answer —
  // it already excludes .svg (never inline), .psd and HEIC, all of which the tile treatment
  // would otherwise class as images and then fail to draw.
  const wantsThumbnail =
    Boolean(onFetchFile)
    && getPreviewMode(fileName) === 'image'
    && fileSize > 0
    && fileSize <= IMAGE_PREVIEW_MAX_BYTES

  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!wantsThumbnail || !onFetchFile) return

    let cancelled = false
    let objectUrl: string | null = null

    void (async () => {
      try {
        // Same negotiation the viewer uses: in S3 mode the route answers with a presigned
        // inline URL and the browser loads the image straight from storage; only local-mode
        // installs hand back bytes for us to wrap in an object URL.
        const response = await onFetchFile(
          `/api/comments/${commentId}/files/${fileId}?inline=1&view=url`
        )
        if (!response.ok) return

        if ((response.headers.get('content-type') || '').includes('application/json')) {
          const payload = await response.json().catch(() => null)
          if (!cancelled && typeof payload?.url === 'string' && payload.url) {
            setThumbnailSrc(payload.url)
          }
          return
        }

        const blob = await response.blob()
        objectUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          objectUrl = null
          return
        }
        setThumbnailSrc(objectUrl)
      } catch {
        // A thumbnail that will not load simply leaves the tinted tile in place.
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [wantsThumbnail, onFetchFile, commentId, fileId])

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  const handleDownload = async () => {
    if (onDownload) {
      try {
        await onDownload(fileId)
      } catch (err) {
        console.error('Error downloading file:', err)
      }
    }
  }

  // A 34px leading tile: the image itself when it is small enough to be worth fetching,
  // otherwise a tinted type icon. The metadata line carries the extension so the file type
  // is still legible when the tile is a photo.
  const chipBody = (
    <>
      <span
        className={
          thumbnailSrc
            ? 'flex h-[34px] w-[34px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted'
            : `flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md ${tileClassName}`
        }
      >
        {thumbnailSrc
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={thumbnailSrc} alt="" className="h-full w-full object-cover" />
          : <TypeIcon className="h-[17px] w-[17px]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-all">{fileName}</span>
        <span className="block text-xs font-normal text-muted-foreground">
          {extension ? `${extension.toUpperCase()} · ` : ''}{formatFileSize(fileSize)}
        </span>
      </span>
    </>
  )

  const chipClassName =
    'flex w-full items-center gap-2.5 px-3 py-2 bg-muted/30 border border-border text-foreground rounded-lg hover:bg-muted/50 transition-colors text-sm font-medium text-left disabled:opacity-50'

  // One target, one action: preview when we can render the file, download when we cannot.
  // Download stays reachable from inside the viewer, so there is no second button here.
  if (canView) {
    return (
      <>
        <button
          type="button"
          onClick={() => setViewerIndex(ownIndex)}
          disabled={isLoading}
          className={chipClassName}
          title={`View ${fileName}`}
        >
          {chipBody}
        </button>

        {viewerIndex !== null && (
          <DocumentViewerModal
            open
            onOpenChange={(v) => { if (!v) setViewerIndex(null) }}
            files={viewerFiles.map((f) => ({ id: f.id, fileName: f.fileName, fileSize: f.fileSize }))}
            index={viewerIndex}
            onIndexChange={setViewerIndex}
            resolveUrl={(f) => `/api/comments/${commentId}/files/${f.id}`}
            fetcher={onFetchFile}
            onDownload={onDownload ? (f) => void onDownload(f.id) : undefined}
          />
        )}
      </>
    )
  }

  if (onDownload) {
    return (
      <button
        type="button"
        onClick={handleDownload}
        disabled={isLoading}
        className={chipClassName}
        title={`Download ${fileName}`}
      >
        {chipBody}
      </button>
    )
  }

  return (
    <a
      href={`/api/comments/${commentId}/files/${fileId}`}
      className={chipClassName}
      title={`Download ${fileName}`}
      download
    >
      {chipBody}
    </a>
  )
}
