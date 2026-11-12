'use client'

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { GuestAlbumLinkDialog, GuestVideoLinkDialog } from '@/components/GuestVideoLinkDialog'
import { InputDialog } from '@/components/ui/input-dialog'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import { DocumentViewerModal } from '@/components/DocumentViewerModal'
import { canPreviewFile } from '@/lib/document-preview'
import VideoHoverPreview from '@/components/VideoHoverPreview'
import { HlsVideo } from '@/components/HlsVideo'
import type { TransferItem } from '@/lib/transfer-state'
import { ZIP_DOWNLOAD_THRESHOLD_BYTES } from '@/lib/transfer-state'
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  File,
  Files,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Images,
  Info,
  Lock,
  Pencil,
  RotateCcw,
  MessageSquare,
  Share2,
  MoreHorizontal,
  Play,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { FolderPreviewMosaic } from './FolderPreviewMosaic'

type DownloadProgressSnapshot = {
  percent: number
  speedBytesPerSecond: number | null
  etaSeconds: number | null
}

const FILES_CHECKBOX_CLASS = 'rounded accent-primary/75 opacity-70 checked:opacity-100 transition-opacity'

const isSelectableDownloadableFile = (file: DownloadableFile, isAdmin = false): boolean => {
  if (file.type !== 'video') return true
  return isAdmin || file.isApproved === true
}

// The files a folder contributes to a bulk selection (root "Select all", the folder card's
// checkbox, "Select folder"). A video folder contributes its delivery only: the approved
// version plus the video's assets, and nothing until a version is approved. Admins can still
// download any version one at a time, but For Review / Reviewed folders and superseded
// versions must never be swept into a bulk download.
// An album contributes its ZIPs (full resolution, plus social sizes when built) rather than
// every photo as well — otherwise the full-res photos came down twice, and one request per
// photo on a large album is the burst pattern that trips the IPS. The individual photos are
// the fallback only while no ZIP is ready, so the album is never silently skipped.
const getGroupSelectableFiles = (group: DownloadableGroup, isAdmin = false): DownloadableFile[] => {
  const files = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
  if (group.groupType === 'video') {
    const approved = files.find((file) => file.type === 'video' && file.isApproved === true)
    if (!approved) return []
    return [approved, ...files.filter((file) => file.type !== 'video')]
  }
  if (group.groupType === 'album') {
    const zips = files.filter((file) => file.type === 'album-zip')
    return zips.length > 0 ? zips : files.filter((file) => file.type === 'album-photo')
  }
  return files.filter((file) => isSelectableDownloadableFile(file, isAdmin))
}

const getVersionNumberFromLabel = (label?: string): number | null => {
  if (!label) return null
  const match = String(label).match(/\d+/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

// A video group is "Reviewed" when no version is approved AND the latest version has had
// its next version requested. Keep this predicate in sync with VideoSidebar's
// isReviewedGroup and the share page's video ordering helper.
const isVideoGroupReviewed = (group: DownloadableGroup): boolean => {
  if (group.groupType !== 'video') return false
  const videoFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
    .filter((f) => f.type === 'video')
  if (videoFiles.length === 0) return false
  if (videoFiles.some((f) => f.isApproved === true)) return false
  const latest = [...videoFiles].sort(
    (a, b) => (getVersionNumberFromLabel(b.versionLabel) ?? -1) - (getVersionNumberFromLabel(a.versionLabel) ?? -1)
  )[0]
  return latest?.isRevisionRequested === true
}

type ShareFilesBrowserProps = {
  groups: DownloadableGroup[]
  selectedFileIds: Set<string>
  setSelectedFileIds: React.Dispatch<React.SetStateAction<Set<string>>>
  onDownloadFile: (file: DownloadableFile) => Promise<void>
  onOpenVideoVersion?: (file: DownloadableFile, folderName: string | null) => void
  onDownloadFiles?: (files: DownloadableFile[], onProgress?: (progress: DownloadProgressSnapshot) => void) => Promise<void>
  sharedDownloadProgress?: DownloadProgressSnapshot | null
  isSharedDownloadActive?: boolean
  onCloseFilesView?: () => void
  requestedOpenFolderName?: string | null
  requestedOpenFileKey?: string | null
  onOpenFileKeyHandled?: () => void
  onOpenFolderNameChange?: (folderName: string | null) => void
  folderPreviewByName?: Record<string, string | null>
  resolveFilePreviewUrl?: (file: DownloadableFile) => Promise<string | null>
  resolveFilePlaybackUrl?: (file: DownloadableFile) => Promise<string | null>
  /**
   * Mints a URL that serves a document inline, for the in-app viewer. Share files are
   * addressed by a short-lived content token rather than an Authorization header, so the
   * page owns this; without it, documents stay download-only.
   */
  resolveDocumentViewUrl?: (file: DownloadableFile) => Promise<string | null>
  shareSlug?: string
  shareToken?: string | null
  transferItems?: TransferItem[]
  canUploadToProjects?: boolean
  canDeleteUploads?: boolean
  onCreateUploadFolder?: (parentPath: string, folderName: string) => Promise<void>
  onUploadFiles?: (folderPath: string, files: File[]) => Promise<void>
  onDeleteUploadFile?: (fileId: string) => Promise<void>
  onDeleteUploadFolder?: (folderPath: string) => Promise<void>
  onRenameUploadFolder?: (folderPath: string, folderName: string) => Promise<void>
  onPreviewTokenExpired?: () => void
  onApproveVideo?: (file: DownloadableFile) => Promise<void>
  /** Client share page only: lodge "Request Next Version" for the latest video version. */
  onRequestNextVersion?: (file: DownloadableFile) => Promise<void>
  /** Project id, for the Share Video (view-only guest link) dialog. */
  projectId?: string | null
  /** Admin users can interact with all versions regardless of approval status. */
  isAdmin?: boolean
  /**
   * The project's status is APPROVED. Signing off approves every approvable video, so a video
   * folder with no approved version is view-only: it moves to a "View Only" section and its
   * detail view drops the Approve / Request next version actions (the API refuses them anyway).
   */
  projectApproved?: boolean
}

function getFileTypeIcon(file: DownloadableFile) {
  const kind = getDownloadableFileKind(file)
  if (kind === 'video') return FileVideo
  if (kind === 'image') return FileImage
  if (kind === 'audio') return FileAudio
  if (kind === 'archive') return FileArchive
  if (kind === 'document') return FileText
  return File
}

function formatFileSize(value: DownloadableFile['fileSizeBytes']): string | null {
  const bytes = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(bytes) || (bytes as number) < 0) return null

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = bytes as number
  let unitIndex = 0
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }

  const precision = amount >= 100 || unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2
  return `${amount.toFixed(precision)} ${units[unitIndex]}`
}

function formatDuration(value: number | undefined): string | null {
  if (!Number.isFinite(value) || (value as number) <= 0) return null
  const total = Math.max(0, Math.floor(value as number))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** "4 Nov", or "4 Nov 2025" outside the current year. */
function formatShortDate(value: string | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-AU', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Short quality label from pixel dimensions: "1080p", "720p", "4K". */
function formatResolutionLabel(width?: number, height?: number): string | null {
  if (!width || !height) return null
  const shortSide = Math.min(width, height)
  if (shortSide >= 2160) return '4K'
  return `${shortSide}p`
}

function formatCodecLabel(codec?: string): string | null {
  const value = String(codec || '').trim().toLowerCase()
  if (!value) return null
  if (value === 'h264' || value === 'avc' || value === 'avc1') return 'H.264'
  if (value === 'hevc' || value === 'h265' || value === 'hvc1') return 'H.265'
  if (value.startsWith('prores')) return 'ProRes'
  if (value === 'dnxhd' || value === 'dnxhr') return 'DNxHD'
  return value.toUpperCase()
}

function joinMeta(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ')
}

function getFileSizeBytes(file: DownloadableFile): number {
  const raw = typeof file.fileSizeBytes === 'string' ? Number(file.fileSizeBytes) : file.fileSizeBytes
  return Number.isFinite(raw) && (raw as number) > 0 ? Number(raw) : 0
}

function getAssetKindLabel(file: DownloadableFile): string {
  const ext = String(file.fileName || '').split('.').pop()?.toLowerCase() || ''
  if (ext === 'srt' || ext === 'vtt') return 'Subtitles'
  const kind = getDownloadableFileKind(file)
  if (kind === 'video') return 'Video'
  if (kind === 'image') return 'Image'
  if (kind === 'audio') return 'Audio'
  if (kind === 'archive') return 'Archive'
  if (kind === 'document') return 'Document'
  return 'File'
}

function getFileExtensionLabel(fileName: string): string | null {
  const trimmed = String(fileName || '').trim()
  if (!trimmed) return null

  const dotIndex = trimmed.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) return null

  const ext = trimmed.slice(dotIndex + 1).toUpperCase()
  if (!ext) return null

  return ext.length > 6 ? ext.slice(0, 6) : ext
}

function formatSelectedTotalSize(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const mb = safeBytes / (1024 * 1024)
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`
  }
  return `${mb.toFixed(2)} MB`
}

// A video asset whose playable preview (PREVIEW_MP4) was purged — e.g. after the
// project was closed — while its still image is kept. Such assets must not open a
// player (it would have nothing to play), but their thumbnail still renders.
function isAssetPlaybackPurged(file: DownloadableFile): boolean {
  return file.type === 'asset'
    && getDownloadableFileKind(file) === 'video'
    && file.playbackPreviewAvailable === false
}

function isLightboxMediaFile(file: DownloadableFile): boolean {
  const kind = getDownloadableFileKind(file)
  if (kind === 'image' || kind === 'audio') return true
  if (kind === 'video' && file.type !== 'video') return !isAssetPlaybackPurged(file)
  return false
}

/**
 * A document the in-app viewer can render (PDF, Word, spreadsheet, delimited or plain text).
 *
 * Images are excluded even though the viewer handles them: they already have a lightbox here
 * with its own context menu and navigation, and routing them somewhere else would be a
 * regression, not a feature.
 */
function isViewableDocumentFile(file: DownloadableFile): boolean {
  return getDownloadableFileKind(file) === 'document' && canPreviewFile(file.fileName)
}

export type ContextMenuItemsProps = {
  contextMenu: { file?: DownloadableFile; group?: DownloadableGroup; imageList?: DownloadableFile[] } | null
  file?: DownloadableFile
  group?: DownloadableGroup
  canSelectFile: boolean
  isSelected: boolean
  isGroupSelected: boolean
  canDownloadFile: boolean
  showApproveButton: boolean
  fileKind: ReturnType<typeof getDownloadableFileKind> | null
  isVideoAssetFile: boolean
  openFolder: { name: string; groupType: string } | null
  onPlay: () => void
  onOpenLightbox: () => void
  /** Present only when the file is a document the in-app viewer can render. */
  onOpenDocument?: (() => void) | null
  onOpenFolder: () => void
  onSelect: () => void
  onSelectFolder: () => void
  onDownload: () => void
  onDownloadFolder: () => void
  onApprove: () => void
  onRenameFolder: () => void
  onDeleteFolder: () => void
  onDeleteFile: () => void
  canUploadAdmin: boolean
  onOpenAlbumPhoto: () => void
  albumPhotoSocialDownloadUrl: string | null
  onDownloadSocial: () => void
  /** Whether another version in the same video group is already approved. */
  groupHasApprovedVersion?: boolean
  /** Admin users can interact with all versions regardless of approval status. */
  isAdmin?: boolean
}

export function ContextMenuItems({
  contextMenu,
  file,
  group,
  canSelectFile,
  isSelected,
  isGroupSelected,
  canDownloadFile,
  showApproveButton,
  fileKind,
  isVideoAssetFile,
  onPlay,
  onOpenLightbox,
  onOpenDocument,
  onOpenFolder,
  onSelect,
  onSelectFolder,
  onDownload,
  onDownloadFolder,
  onApprove,
  onRenameFolder,
  onDeleteFolder,
  onDeleteFile,
  canUploadAdmin,
  onOpenAlbumPhoto,
  albumPhotoSocialDownloadUrl,
  onDownloadSocial,
  groupHasApprovedVersion = false,
  isAdmin = false,
}: ContextMenuItemsProps) {
  if (!contextMenu) return null

  const itemClass = 'flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground'
  const destructiveClass = 'flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-destructive hover:bg-destructive/10 hover:text-destructive'
  const separatorClass = 'mx-1 my-1 h-px bg-border'

  // Folder context menu
  if (group) {
    const isUploads = group.groupType === 'uploads'
    const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
    const hasSelectable = groupFiles.some((f) => f.type !== 'video' || isAdmin || f.isApproved === true)

    return (
      <>
        <div className={itemClass} onClick={onOpenFolder}>
          <Folder className="mr-2 h-4 w-4" />
          Open
        </div>
        {hasSelectable ? (
          <div className={itemClass} onClick={onSelectFolder}>
            {isGroupSelected ? <Square className="mr-2 h-4 w-4" /> : <CheckSquare className="mr-2 h-4 w-4" />}
            {isGroupSelected ? 'Deselect' : 'Select'}
          </div>
        ) : null}
        {hasSelectable ? (
          <div className={itemClass} onClick={onDownloadFolder}>
            <Download className="mr-2 h-4 w-4" />
            Download All
          </div>
        ) : null}
        {isUploads && canUploadAdmin ? (
          <>
            <div className={separatorClass} />
            <div className={itemClass} onClick={onRenameFolder}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename folder
            </div>
            <div className={destructiveClass} onClick={onDeleteFolder}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete folder
            </div>
          </>
        ) : null}
      </>
    )
  }

  // File context menu
  if (!file) return null

  const isVideo = file.type === 'video'
  const isAlbumPhoto = file.type === 'album-photo'
  const isAlbumZip = file.type === 'album-zip'
  const isUploadFile = file.type === 'upload-file'
  const isApproved = file.isApproved === true

  return (
    <>
      {/* Play / Open actions */}
      {isVideo && !isApproved && groupHasApprovedVersion && !isAdmin ? (
        <div className={cn(itemClass, 'opacity-50 cursor-default')}>
          <Play className="mr-2 h-4 w-4" />
          Play (another version approved)
        </div>
      ) : isVideo ? (
        <div className={itemClass} onClick={onPlay}>
          <Play className="mr-2 h-4 w-4" />
          Play
        </div>
      ) : !isUploadFile && (isVideoAssetFile || fileKind === 'image' || fileKind === 'audio' || isAlbumPhoto) ? (
        <div className={itemClass} onClick={isAlbumPhoto ? onOpenAlbumPhoto : onOpenLightbox}>
          <Play className="mr-2 h-4 w-4" />
          Open
        </div>
      ) : onOpenDocument ? (
        <div className={itemClass} onClick={onOpenDocument}>
          <Eye className="mr-2 h-4 w-4" />
          View
        </div>
      ) : null}

      {/* Select / Unselect */}
      {canSelectFile ? (
        <div className={itemClass} onClick={onSelect}>
          {isSelected ? <Square className="mr-2 h-4 w-4" /> : <CheckSquare className="mr-2 h-4 w-4" />}
          {isSelected ? 'Deselect' : 'Select'}
        </div>
      ) : null}

      {/* Approve (unapproved video) */}
      {showApproveButton ? (
        <div className={itemClass} onClick={onApprove}>
          <Check className="mr-2 h-4 w-4" />
          Approve version
        </div>
      ) : null}

      {/* Album photo downloads */}
      {isAlbumPhoto && canDownloadFile ? (
        <>
          <div className={itemClass} onClick={onDownload}>
            <Download className="mr-2 h-4 w-4" />
            Download Full Resolution
          </div>
          {albumPhotoSocialDownloadUrl ? (
            <div className={itemClass} onClick={onDownloadSocial}>
              <Download className="mr-2 h-4 w-4" />
              Download Social Sized
            </div>
          ) : null}
        </>
      ) : null}

      {/* Download (non-album files) */}
      {!isAlbumPhoto && canDownloadFile ? (
        <div className={itemClass} onClick={onDownload}>
          <Download className="mr-2 h-4 w-4" />
          Download
        </div>
      ) : null}

      {/* Upload file delete */}
      {isUploadFile && canUploadAdmin ? (
        <>
          <div className={separatorClass} />
          <div className={destructiveClass} onClick={onDeleteFile}>
            <Trash2 className="mr-2 h-4 w-4" />
            Delete file
          </div>
        </>
      ) : null}
    </>
  )
}

export function ShareFilesBrowser({
  groups,
  selectedFileIds,
  setSelectedFileIds,
  onDownloadFile,
  onOpenVideoVersion,
  onDownloadFiles,
  sharedDownloadProgress,
  isSharedDownloadActive = false,
  onCloseFilesView,
  requestedOpenFolderName,
  requestedOpenFileKey,
  onOpenFileKeyHandled,
  onOpenFolderNameChange,
  folderPreviewByName,
  resolveFilePreviewUrl,
  resolveFilePlaybackUrl,
  resolveDocumentViewUrl,
  shareSlug,
  shareToken,
  transferItems = [],
  canUploadToProjects = false,
  canDeleteUploads = false,
  onCreateUploadFolder,
  onUploadFiles,
  onDeleteUploadFile,
  onDeleteUploadFolder,
  onRenameUploadFolder,
  onPreviewTokenExpired,
  onApproveVideo,
  onRequestNextVersion,
  projectId,
  isAdmin = false,
  projectApproved = false,
}: ShareFilesBrowserProps) {
  // Initialise from the parent's requested folder so a freshly-mounted browser
  // (e.g. after switching from the player back to FILES) opens the right folder
  // instead of starting at root and then bouncing.
  const [openFolderName, setOpenFolderName] = useState<string | null>(() => {
    const requested = String(requestedOpenFolderName || '').trim()
    return requested ? requested : null
  })
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false)
  const [bulkFsaUnsupportedFiles, setBulkFsaUnsupportedFiles] = useState<DownloadableFile[] | null>(null)
  const [localDownloadProgress, setLocalDownloadProgress] = useState<DownloadProgressSnapshot | null>(null)
  const [previewUrlByFileKey, setPreviewUrlByFileKey] = useState<Record<string, string | null>>({})
  const [derivedVideoDurationByFileKey, setDerivedVideoDurationByFileKey] = useState<Record<string, number | null>>({})
  const [folderPreviewTilesByName, setFolderPreviewTilesByName] = useState<Record<string, string[]>>({})
  const [folderPreviewPosterByName, setFolderPreviewPosterByName] = useState<Record<string, string | null>>({})
  const [lightboxState, setLightboxState] = useState<{ images: DownloadableFile[]; currentIndex: number } | null>(null)
  const [approveConfirmFile, setApproveConfirmFile] = useState<DownloadableFile | null>(null)
  const [approveConfirmVideoName, setApproveConfirmVideoName] = useState<string>('')
  const [approving, setApproving] = useState(false)
  const approvingRef = useRef(false)
  const [requestNextFile, setRequestNextFile] = useState<DownloadableFile | null>(null)
  const [requestingNext, setRequestingNext] = useState(false)
  const requestingNextRef = useRef(false)
  const [shareVideoId, setShareVideoId] = useState<string | null>(null)
  const [shareAlbumId, setShareAlbumId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file?: DownloadableFile
    group?: DownloadableGroup
    imageList?: DownloadableFile[]
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const [lightboxContextMenu, setLightboxContextMenu] = useState<{ x: number; y: number; file: DownloadableFile } | null>(null)
  const lightboxContextMenuRef = useRef<HTMLDivElement | null>(null)
  const [audioLightboxState, setAudioLightboxState] = useState<{ files: DownloadableFile[]; currentIndex: number } | null>(null)
  const [documentViewerState, setDocumentViewerState] = useState<{ files: DownloadableFile[]; currentIndex: number } | null>(null)
  const [audioPlaybackUrlByFileKey, setAudioPlaybackUrlByFileKey] = useState<Record<string, string | null>>({})
  const [videoPlaybackUrlByFileKey, setVideoPlaybackUrlByFileKey] = useState<Record<string, string | null>>({})
  const [albumViewerState, setAlbumViewerState] = useState<{ images: DownloadableFile[]; currentIndex: number; albumId: string | null } | null>(null)
  const [albumPhotoMetaByPhotoId, setAlbumPhotoMetaByPhotoId] = useState<Record<string, { socialDownloadUrl: string; socialReady: boolean }>>({})
  const [albumSocialEnabledByAlbumId, setAlbumSocialEnabledByAlbumId] = useState<Record<string, boolean>>({})
  const [albumMetaLoadedByAlbumId, setAlbumMetaLoadedByAlbumId] = useState<Record<string, boolean>>({})
  const [isUploadActionBusy, setIsUploadActionBusy] = useState(false)
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false)
  const [showRenameFolderDialog, setShowRenameFolderDialog] = useState(false)
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ path: string; name: string } | null>(null)
  const [showDeleteSelectedDialog, setShowDeleteSelectedDialog] = useState(false)
  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null)
  const [pendingDeleteFolderPath, setPendingDeleteFolderPath] = useState<string | null>(null)
  const [albumPhotosThumbnailSize, setAlbumPhotosThumbnailSize] = useState<'small' | 'default' | 'large'>('default')
  const [uploadsThumbnailSize, setUploadsThumbnailSize] = useState<'small' | 'default' | 'large'>('default')
  const [pendingUploadFolderPath, setPendingUploadFolderPath] = useState<string>('')
  const [visibleFolderNames, setVisibleFolderNames] = useState<Set<string>>(new Set())
  const [visibleFileKeys, setVisibleFileKeys] = useState<Set<string>>(new Set())
  const previewRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const audioPlaybackRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const videoPlaybackRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const previewRetryTimerRef = useRef<Map<string, number>>(new Map())
  const previewRetryAttemptRef = useRef<Map<string, number>>(new Map())
  const lastPreviewTokenRefreshAtRef = useRef(0)
  const uploadVideoDurationRequestRef = useRef<Map<string, Promise<number | null>>>(new Map())
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement | null>(null)

  // Each folder opens at its top — otherwise a folder inherits the previous view's
  // scroll offset and a video folder's header can open scrolled out of sight.
  useEffect(() => {
    scrollAreaRef.current?.scrollTo({ top: 0 })
  }, [openFolderName])
  const folderCardObserverRef = useRef<IntersectionObserver | null>(null)
  const fileCardObserverRef = useRef<IntersectionObserver | null>(null)
  const folderCardNodesRef = useRef<Map<string, Element>>(new Map())
  const fileCardNodesRef = useRef<Map<string, Element>>(new Map())

  const requestPreviewTokenRefresh = useCallback(() => {
    if (!onPreviewTokenExpired) return
    const now = Date.now()
    if (now - lastPreviewTokenRefreshAtRef.current < 5000) return
    lastPreviewTokenRefreshAtRef.current = now
    onPreviewTokenExpired()
  }, [onPreviewTokenExpired])

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        close()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown)
    // Close on scroll/wheel
    window.addEventListener('wheel', close, { once: true })
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('wheel', close)
    }
  }, [contextMenu])

  // Close lightbox context menu on outside click or Escape
  useEffect(() => {
    if (!lightboxContextMenu) return
    const close = () => setLightboxContextMenu(null)
    const onMouseDown = (e: MouseEvent) => {
      if (lightboxContextMenuRef.current && !lightboxContextMenuRef.current.contains(e.target as Node)) {
        close()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [lightboxContextMenu])

  useEffect(() => {
    const availableFileKeys = new Set<string>()
    const availableGroupNames = new Set<string>()

    for (const group of groups) {
      availableGroupNames.add(group.name)
      if (group.mainFile) {
        availableFileKeys.add(getDownloadableFileKey(group.mainFile))
      }
      for (const file of group.subFiles) {
        availableFileKeys.add(getDownloadableFileKey(file))
      }
    }

    setPreviewUrlByFileKey((prev) => {
      let changed = false
      const next: Record<string, string | null> = {}

      for (const [fileKey, previewUrl] of Object.entries(prev)) {
        if (availableFileKeys.has(fileKey)) {
          next[fileKey] = previewUrl
        } else {
          changed = true
          previewRequestRef.current.delete(fileKey)
          const retryTimer = previewRetryTimerRef.current.get(fileKey)
          if (retryTimer != null) {
            window.clearTimeout(retryTimer)
            previewRetryTimerRef.current.delete(fileKey)
          }
          previewRetryAttemptRef.current.delete(fileKey)
        }
      }

      return changed ? next : prev
    })

    setFolderPreviewTilesByName((prev) => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [groupName, tiles] of Object.entries(prev)) {
        if (availableGroupNames.has(groupName)) {
          next[groupName] = tiles
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    setFolderPreviewPosterByName((prev) => {
      let changed = false
      const next: Record<string, string | null> = {}
      for (const [groupName, posterUrl] of Object.entries(prev)) {
        if (availableGroupNames.has(groupName)) {
          next[groupName] = posterUrl
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    setAudioPlaybackUrlByFileKey((prev) => {
      let changed = false
      const next: Record<string, string | null> = {}

      for (const [fileKey, playbackUrl] of Object.entries(prev)) {
        if (availableFileKeys.has(fileKey)) {
          next[fileKey] = playbackUrl
        } else {
          changed = true
          audioPlaybackRequestRef.current.delete(fileKey)
        }
      }

      return changed ? next : prev
    })

    setVideoPlaybackUrlByFileKey((prev) => {
      let changed = false
      const next: Record<string, string | null> = {}

      for (const [fileKey, playbackUrl] of Object.entries(prev)) {
        if (availableFileKeys.has(fileKey)) {
          next[fileKey] = playbackUrl
        } else {
          changed = true
          videoPlaybackRequestRef.current.delete(fileKey)
        }
      }

      return changed ? next : prev
    })
  }, [groups])

  useEffect(() => {
    const previewRetryTimers = new Map(previewRetryTimerRef.current)
    const previewRetryAttempts = previewRetryAttemptRef.current

    return () => {
      previewRetryTimers.forEach((timerId) => window.clearTimeout(timerId))
      previewRetryTimers.clear()
      previewRetryAttempts.clear()
    }
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleFolderNames((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const folderName = entry.target.getAttribute('data-folder-preview-key')
            if (!folderName) continue
            if (entry.isIntersecting) {
              if (!next.has(folderName)) {
                next.add(folderName)
                changed = true
              }
              continue
            }

            if (next.delete(folderName)) {
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root: null, rootMargin: '240px 0px', threshold: 0.01 }
    )

    folderCardObserverRef.current = observer
    return () => {
      observer.disconnect()
      folderCardObserverRef.current = null
    }
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleFileKeys((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const entry of entries) {
            const fileKey = entry.target.getAttribute('data-file-preview-key')
            if (!fileKey) continue
            if (entry.isIntersecting) {
              if (!next.has(fileKey)) {
                next.add(fileKey)
                changed = true
              }
              continue
            }

            if (next.delete(fileKey)) {
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root: null, rootMargin: '200px 0px', threshold: 0.01 }
    )

    fileCardObserverRef.current = observer
    return () => {
      observer.disconnect()
      fileCardObserverRef.current = null
    }
  }, [])

  const registerFolderPreviewCardRef = useCallback((folderName: string, node: HTMLDivElement | null) => {
    const prevNode = folderCardNodesRef.current.get(folderName)
    if (prevNode && prevNode !== node) {
      folderCardObserverRef.current?.unobserve(prevNode)
      folderCardNodesRef.current.delete(folderName)
    }

    if (!node) return

    folderCardNodesRef.current.set(folderName, node)
    folderCardObserverRef.current?.observe(node)
  }, [])

  const registerFilePreviewCardRef = useCallback((fileKey: string, node: HTMLDivElement | null) => {
    const prevNode = fileCardNodesRef.current.get(fileKey)
    if (prevNode && prevNode !== node) {
      fileCardObserverRef.current?.unobserve(prevNode)
      fileCardNodesRef.current.delete(fileKey)
    }

    if (!node) return

    fileCardNodesRef.current.set(fileKey, node)
    fileCardObserverRef.current?.observe(node)
  }, [])

  useEffect(() => {
    const activeFolderNames = new Set(groups.map((group) => group.name))
    setVisibleFolderNames((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const folderName of prev) {
        if (!activeFolderNames.has(folderName)) {
          changed = true
          continue
        }
        next.add(folderName)
      }
      return changed ? next : prev
    })
  }, [groups])

  useEffect(() => {
    const activeFileKeys = new Set<string>()
    for (const group of groups) {
      if (group.mainFile) {
        activeFileKeys.add(getDownloadableFileKey(group.mainFile))
      }
      for (const file of group.subFiles) {
        activeFileKeys.add(getDownloadableFileKey(file))
      }
    }

    setVisibleFileKeys((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const fileKey of prev) {
        if (!activeFileKeys.has(fileKey)) {
          changed = true
          continue
        }
        next.add(fileKey)
      }
      return changed ? next : prev
    })
  }, [groups])

  const schedulePreviewRetry = useCallback((fileKey: string) => {
    if (previewRetryTimerRef.current.has(fileKey)) return

    const attempt = (previewRetryAttemptRef.current.get(fileKey) || 0) + 1
    previewRetryAttemptRef.current.set(fileKey, attempt)
    const delayMs = Math.min(2 * 60 * 1000, 8000 * (2 ** (attempt - 1)))

    const timerId = window.setTimeout(() => {
      previewRetryTimerRef.current.delete(fileKey)
      setPreviewUrlByFileKey((prev) => {
        if (prev[fileKey] !== null) return prev
        const next = { ...prev }
        delete next[fileKey]
        return next
      })
    }, delayMs)

    previewRetryTimerRef.current.set(fileKey, timerId)
  }, [])

  const invalidatePreviewForFileKey = useCallback((fileKey: string) => {
    previewRequestRef.current.delete(fileKey)

    const retryTimer = previewRetryTimerRef.current.get(fileKey)
    if (retryTimer != null) {
      window.clearTimeout(retryTimer)
      previewRetryTimerRef.current.delete(fileKey)
    }
    previewRetryAttemptRef.current.delete(fileKey)

    setPreviewUrlByFileKey((prev) => {
      if (prev[fileKey] === undefined) return prev
      const next = { ...prev }
      delete next[fileKey]
      return next
    })
  }, [])

  const invalidateFolderPreviewTiles = useCallback((groupName: string) => {
    setFolderPreviewTilesByName((prev) => {
      if (prev[groupName] === undefined) return prev
      const next = { ...prev }
      delete next[groupName]
      return next
    })
    setFolderPreviewPosterByName((prev) => {
      if (prev[groupName] === undefined) return prev
      const next = { ...prev }
      delete next[groupName]
      return next
    })
  }, [])


  const looksLikeVideoUrl = useCallback((value: string): boolean => {
    const lower = value.toLowerCase()
    if (lower.startsWith('blob:')) return true
    if (/\.(mp4|mov|m4v|webm|mkv)(\?|$)/.test(lower)) return true
    if (lower.includes('assetplayback=1')) return true
    if (lower.includes('download=true') && lower.includes('assetid=')) return true
    return false
  }, [])

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [groups])

  const rootVideoGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType === 'video'),
    [sortedGroups]
  )

  // Root Videos section is split into "For Review" / "Reviewed" / "Approved" (mirrors
  // VideoSidebar's own grouping), so a folder moves section the moment any of its
  // versions is approved or its latest version has the next version requested.
  // Once the project is approved, unapproved folders are "View Only" instead (see projectApproved).
  const rootVideoGroupsForReview = useMemo(
    () => projectApproved ? [] : rootVideoGroups.filter((group) => {
      const files = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
      return !files.some((f) => f.type === 'video' && f.isApproved === true) && !isVideoGroupReviewed(group)
    }),
    [rootVideoGroups, projectApproved]
  )

  const rootVideoGroupsReviewed = useMemo(
    () => projectApproved ? [] : rootVideoGroups.filter((group) => isVideoGroupReviewed(group)),
    [rootVideoGroups, projectApproved]
  )

  const rootVideoGroupsViewOnly = useMemo(
    () => !projectApproved ? [] : rootVideoGroups.filter((group) => {
      const files = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
      return !files.some((f) => f.type === 'video' && f.isApproved === true)
    }),
    [rootVideoGroups, projectApproved]
  )

  const rootVideoGroupsApproved = useMemo(
    () => rootVideoGroups.filter((group) => {
      const files = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
      return files.some((f) => f.type === 'video' && f.isApproved === true)
    }),
    [rootVideoGroups]
  )

  const rootAlbumGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType === 'album'),
    [sortedGroups]
  )

  const rootUploadGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType === 'uploads'),
    [sortedGroups]
  )

  const projectRootGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType !== 'uploads'),
    [sortedGroups]
  )

  const uploadsRootGroup = useMemo<DownloadableGroup>(() => {
    return rootUploadGroups.find((group) => group.name === 'UPLOADS') || {
      name: 'UPLOADS',
      groupType: 'uploads',
      subFiles: [],
    }
  }, [rootUploadGroups])

  // Render one root card per top-level upload folder (matching the sidebar's UPLOADS
  // section), instead of a single consolidated "UPLOADS" card. Server groups are named
  // `UPLOADS / <path>`; we bucket them by their first path segment so nested
  // (client-created) subfolders roll up into their top-level parent's card for the
  // count + preview mosaic. Clicking a card navigates to the real `UPLOADS / <top>`
  // group, which drills in to show that folder's direct files + subfolders. Loose
  // root-level files (the bare `UPLOADS` group) are intentionally not surfaced as a card.
  const rootUploadsSectionGroups = useMemo<DownloadableGroup[]>(() => {
    const byTop = new Map<string, DownloadableGroup>()
    for (const group of rootUploadGroups) {
      const normalized = String(group.name || '').trim()
      const withoutPrefix = normalized.replace(/^UPLOADS\s*\/\s*/i, '')
      if (!withoutPrefix || withoutPrefix === normalized) continue // skip bare `UPLOADS` root
      const top = withoutPrefix.split('/').map((s) => s.trim()).filter(Boolean)[0]
      if (!top) continue
      const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
      const existing = byTop.get(top)
      if (existing) {
        existing.subFiles = [...existing.subFiles, ...groupFiles]
      } else {
        byTop.set(top, { name: `UPLOADS / ${top}`, groupType: 'uploads', subFiles: [...groupFiles] })
      }
    }
    return [...byTop.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [rootUploadGroups])

  const openUploadsRoot = openFolderName === 'UPLOADS' && rootUploadGroups.length > 0

  const openFolder = useMemo(() => {
    if (!openFolderName) return null
    if (openFolderName === 'UPLOADS' && rootUploadGroups.length > 0) {
      return uploadsRootGroup
    }
    return sortedGroups.find((group) => group.name === openFolderName) || null
  }, [openFolderName, sortedGroups, rootUploadGroups.length, uploadsRootGroup])

  const filesInOpenFolder = useMemo(() => {
    if (!openFolder) return []
    return [...(openFolder.mainFile ? [openFolder.mainFile] : []), ...openFolder.subFiles]
  }, [openFolder])

  // Don't allow approving another video version if one in the same group is already approved.
  const groupHasApprovedVersion = useMemo(() => {
    if (!openFolder || openFolder.groupType !== 'video') return false
    return [...(openFolder.mainFile ? [openFolder.mainFile] : []), ...openFolder.subFiles]
      .some((f) => f.type === 'video' && f.isApproved === true)
  }, [openFolder])

  // Navigate to a folder (or null for the project root) in response to genuine
  // in-browser navigation, and report it to the parent so the sidebar selection
  // stays in sync. The parent → child direction is handled one-way by the
  // requestedOpenFolderName effect below; we deliberately do NOT mirror
  // openFolderName back to the parent from an effect watching it, because a
  // two-way effect sync oscillates (parent ⇄ child) and trips React's
  // "maximum update depth" guard (#185).
  const navigateToFolder = useCallback((name: string | null) => {
    setOpenFolderName(name)
    onOpenFolderNameChange?.(name)
  }, [onOpenFolderNameChange])

  useEffect(() => {
    if (!openFolderName) return
    if (openFolderName === 'UPLOADS' && rootUploadGroups.length > 0) {
      return
    }
    if (!sortedGroups.some((group) => group.name === openFolderName)) {
      // The folder we were viewing no longer exists (e.g. it was deleted). Drop to
      // the project root and let the parent know so the sidebar deselects too.
      navigateToFolder(null)
    }
  }, [openFolderName, sortedGroups, rootUploadGroups.length, navigateToFolder])

  useEffect(() => {
    const requested = String(requestedOpenFolderName || '').trim()
    // Resolve the folder the parent is asking for. Empty → project root (e.g.
    // deselecting the active sidebar item in the combined files view).
    let target: string | null = null
    if (!requested) {
      target = null
    } else if (requested === 'UPLOADS' && rootUploadGroups.length > 0) {
      target = 'UPLOADS'
    } else {
      const matchingGroup = sortedGroups.find((group) => group.name === requested)
      target = matchingGroup ? matchingGroup.name : null
    }

    // One-way: apply the parent's request to the local view. This must NOT report
    // back to the parent (no onOpenFolderNameChange) — the parent already knows.
    setOpenFolderName(target)
  }, [requestedOpenFolderName, sortedGroups, rootUploadGroups.length])

  const getUploadsFolderPathFromGroup = useCallback((groupName: string): string => {
    const normalized = String(groupName || '').trim()
    if (!normalized || normalized === 'UPLOADS') return ''

    // Accept both "UPLOADS / foo" and "UPLOADS/foo" forms from server payloads.
    const withoutPrefix = normalized.replace(/^UPLOADS\s*\/\s*/i, '')
    if (!withoutPrefix || withoutPrefix === normalized) return ''

    return withoutPrefix
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join('/')
  }, [])

  const getUploadsFolderLabelFromGroup = useCallback((groupName: string): string => {
    const relativePath = getUploadsFolderPathFromGroup(groupName)
    if (!relativePath) return 'Additional Files'
    // Show only the leaf segment. A folder card always sits inside its parent's view,
    // so the full relative path (e.g. "TEST/TEST 2") would be redundant and reads like
    // a flat sibling rather than a nested folder. The breadcrumb conveys the full path.
    const segments = relativePath.split('/').map((segment) => segment.trim()).filter(Boolean)
    return segments[segments.length - 1] || relativePath
  }, [getUploadsFolderPathFromGroup])

  const getFolderHierarchySegments = useCallback((folderName: string): string[] => {
    const normalized = String(folderName || '').trim()
    if (!normalized) return []

    if (/^UPLOADS\s*\//i.test(normalized)) {
      const relativePath = normalized.replace(/^UPLOADS\s*\/\s*/i, '')
      const pathSegments = relativePath
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean)
      return ['UPLOADS', ...pathSegments]
    }

    if (normalized.includes(' / ')) {
      return normalized
        .split(' / ')
        .map((segment) => segment.trim())
        .filter(Boolean)
    }

    return [normalized]
  }, [])

  const buildFolderNameFromSegments = useCallback((segments: string[]): string | null => {
    if (!segments.length) return null
    if (segments[0] === 'UPLOADS') {
      if (segments.length === 1) return 'UPLOADS'
      return `UPLOADS / ${segments.slice(1).join('/')}`
    }
    if (segments.length === 1) return segments[0]
    return segments.join(' / ')
  }, [])

  const folderNameByHierarchyKey = useMemo(() => {
    const map = new Map<string, string>()
    sortedGroups.forEach((group) => {
      const key = getFolderHierarchySegments(group.name).join('\u001f')
      if (key) map.set(key, group.name)
    })
    return map
  }, [sortedGroups, getFolderHierarchySegments])

  const resolveFolderNameFromSegments = useCallback((segments: string[]): string | null => {
    const key = segments.join('\u001f')
    const existing = folderNameByHierarchyKey.get(key)
    if (existing) return existing
    return buildFolderNameFromSegments(segments)
  }, [folderNameByHierarchyKey, buildFolderNameFromSegments])

  const uploadsTargetFolderPath = useMemo(() => {
    if (openFolder?.groupType === 'uploads') {
      return getUploadsFolderPathFromGroup(openFolder.name)
    }
    return ''
  }, [getUploadsFolderPathFromGroup, openFolder])

  const isUploadsContext = useMemo(() => {
    return openFolder?.groupType === 'uploads'
  }, [openFolder])

  const navigateBackFolder = useCallback(() => {
    if (!openFolderName) return

    const segments = getFolderHierarchySegments(openFolderName)
    if (segments.length <= 1) {
      navigateToFolder(null)
      return
    }

    const parentSegments = segments.slice(0, -1)
    const resolvedParentName = resolveFolderNameFromSegments(parentSegments)
    if (!resolvedParentName) {
      navigateToFolder(null)
      return
    }

    // The bare UPLOADS root is no longer a browsable view (each top-level upload
    // folder is its own card at the project root), so backing out of a top-level
    // uploads folder returns to the project root rather than the uploads root.
    if (resolvedParentName === 'UPLOADS') {
      navigateToFolder(null)
      return
    }

    navigateToFolder(resolvedParentName)
  }, [openFolderName, getFolderHierarchySegments, resolveFolderNameFromSegments, navigateToFolder])

  useEffect(() => {
    const handleOpenRoot = () => {
      navigateToFolder(null)
    }

    window.addEventListener('shareOpenFilesRoot', handleOpenRoot)
    return () => {
      window.removeEventListener('shareOpenFilesRoot', handleOpenRoot)
    }
  }, [navigateToFolder])

  useEffect(() => {
    let cancelled = false

    async function resolveFolderPreviewTiles() {
      if (!resolveFilePreviewUrl || visibleFolderNames.size === 0) return

      const visibleGroups = sortedGroups.filter((group) => visibleFolderNames.has(group.name))
      const groupsToResolve = visibleGroups.filter((group) => {
        const existingTiles = folderPreviewTilesByName[group.name]
        const existingPoster = folderPreviewPosterByName[group.name]
        return existingTiles === undefined || existingPoster === undefined
      })

      if (groupsToResolve.length === 0) return

      const nextTiles: Record<string, string[]> = {}
      const nextPoster: Record<string, string | null> = {}

      for (const group of groupsToResolve) {
        const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
        const uniqueUrls: string[] = []

        // Scan a broader set of previewable files so uploads folders can fill
        // a 3-tile mosaic even when early files have no ready preview yet.
        const previewCandidates = groupFiles
          .filter((file) => {
            const kind = getDownloadableFileKind(file)
            return kind === 'image' || kind === 'video'
          })
          .slice(0, 12)

        for (const file of previewCandidates) {
          try {
            const url = await resolveFilePreviewUrl(file)
            if (typeof url !== 'string' || url.length === 0) continue
            if (uniqueUrls.includes(url)) continue
            uniqueUrls.push(url)
            if (uniqueUrls.length >= 3) break
          } catch {
            continue
          }
        }

        if (uniqueUrls.length === 0) {
          const fallback = folderPreviewByName?.[group.name]
          if (typeof fallback === 'string' && fallback.length > 0) {
            uniqueUrls.push(fallback)
          }
        }

        nextTiles[group.name] = uniqueUrls

        if (uniqueUrls.length === 0) {
          const videoCandidate = groupFiles.find((file) => getDownloadableFileKind(file) === 'video')
          if (videoCandidate) {
            try {
              const videoUrl = await resolveFilePreviewUrl(videoCandidate)
              // Only use server-provided previews. Previously non-upload video
              // candidates were turned into a poster by downloading the video and
              // grabbing a frame client-side; that pulled video bytes just to fill a
              // folder tile, so we now fall back to the icon instead.
              nextPoster[group.name] = (
                videoCandidate.type === 'upload-file'
                && typeof videoUrl === 'string'
                && videoUrl.length > 0
              )
                ? videoUrl
                : null
            } catch {
              nextPoster[group.name] = null
            }
          } else {
            nextPoster[group.name] = null
          }
        } else {
          nextPoster[group.name] = null
        }
      }

      if (!cancelled) {
        setFolderPreviewTilesByName((prev) => ({ ...prev, ...nextTiles }))
        setFolderPreviewPosterByName((prev) => ({ ...prev, ...nextPoster }))
      }
    }

    void resolveFolderPreviewTiles()

    return () => {
      cancelled = true
    }
  }, [
    sortedGroups,
    resolveFilePreviewUrl,
    folderPreviewByName,
    visibleFolderNames,
    folderPreviewTilesByName,
    folderPreviewPosterByName,
  ])

  useEffect(() => {
    if (!filesInOpenFolder.length) return

    filesInOpenFolder.forEach((file) => {
      const fileKey = getDownloadableFileKey(file)
      // Video-version posters resolve from the share page's in-memory thumbnail map (no
      // request), and the same version can appear in both the hero and the versions list,
      // so they skip the visibility gate the per-file card observer provides.
      if (file.type !== 'video' && !visibleFileKeys.has(fileKey)) return
      if (previewUrlByFileKey[fileKey] !== undefined) return
      const fileKind = getDownloadableFileKind(file)
      if (fileKind !== 'image' && fileKind !== 'video') return

      if (file.type === 'upload-file' && String(file.uploadFileId || '').startsWith('pending-')) {
        return
      }

      const embeddedPreview = file.thumbnailUrl || file.previewUrl || null
      if (embeddedPreview) {
        const retryTimer = previewRetryTimerRef.current.get(fileKey)
        if (retryTimer != null) {
          window.clearTimeout(retryTimer)
          previewRetryTimerRef.current.delete(fileKey)
        }
        previewRetryAttemptRef.current.delete(fileKey)
        setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: embeddedPreview }))
        return
      }

      const inFlight = previewRequestRef.current.get(fileKey)
      if (inFlight) return

      if (!resolveFilePreviewUrl) return

      const request = resolveFilePreviewUrl(file)
        .then(async (url) => {
          if (!url) {
            setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
            if (file.type === 'upload-file' && file.previewStatus !== 'FAILED') {
              schedulePreviewRetry(fileKey)
            }
            return null
          }

          // If the only resolved preview is a video URL (no server-side image
          // thumbnail), fall back to the icon rather than downloading the video to
          // synthesize a poster frame client-side.
          if (fileKind === 'video' && looksLikeVideoUrl(url)) {
            setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
            if (file.type === 'upload-file' && file.previewStatus !== 'FAILED') {
              schedulePreviewRetry(fileKey)
            }
            return null
          }
          const displayUrl = url

          const retryTimer = previewRetryTimerRef.current.get(fileKey)
          if (retryTimer != null) {
            window.clearTimeout(retryTimer)
            previewRetryTimerRef.current.delete(fileKey)
          }
          previewRetryAttemptRef.current.delete(fileKey)

          setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: displayUrl }))
          return displayUrl
        })
        .catch(() => {
          setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
          if (file.type === 'upload-file' && file.previewStatus !== 'FAILED') {
            schedulePreviewRetry(fileKey)
          }
          return null
        })
        .finally(() => {
          previewRequestRef.current.delete(fileKey)
        })

      previewRequestRef.current.set(fileKey, request)
    })
  }, [
    filesInOpenFolder,
    previewUrlByFileKey,
    resolveFilePreviewUrl,
    looksLikeVideoUrl,
    schedulePreviewRetry,
    visibleFileKeys,
  ])

  // Avoid automatic upload-video metadata probing from preview URLs.
  // Duration labels rely on persisted metadata captured during upload.

  const toggleFile = (fileKey: string, checked: boolean) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(fileKey)
      else next.delete(fileKey)
      return next
    })
  }

  const toggleGroup = (group: DownloadableGroup, checked: boolean) => {
    const fileKeys = getGroupSelectableFiles(group, isAdmin).map(getDownloadableFileKey)
    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        fileKeys.forEach((key) => next.add(key))
      } else {
        fileKeys.forEach((key) => next.delete(key))
      }
      return next
    })
  }

  const toggleSubset = (files: DownloadableFile[], checked: boolean) => {
    const subsetKeys = files
      .filter((file) => isSelectableDownloadableFile(file, isAdmin))
      .map(getDownloadableFileKey)
    if (!subsetKeys.length) return

    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        subsetKeys.forEach((key) => next.add(key))
      } else {
        subsetKeys.forEach((key) => next.delete(key))
      }
      return next
    })
  }

  const getSubsetSelectionState = (files: DownloadableFile[]) => {
    const total = files.length
    const selected = files.reduce((count, file) => {
      const key = getDownloadableFileKey(file)
      return selectedFileIds.has(key) ? count + 1 : count
    }, 0)

    return {
      allChecked: total > 0 && selected === total,
      someChecked: selected > 0 && selected < total,
    }
  }

  const selectedCount = selectedFileIds.size
  const selectedTotalSizeBytes = useMemo(() => {
    if (selectedFileIds.size === 0) return 0

    const fileByKey = new Map<string, DownloadableFile>()
    groups.forEach((group) => {
      ;[...(group.mainFile ? [group.mainFile] : []), ...group.subFiles].forEach((file) => {
        fileByKey.set(getDownloadableFileKey(file), file)
      })
    })

    return Array.from(selectedFileIds).reduce((total, key) => {
      const file = fileByKey.get(key)
      if (!file) return total
      const rawSize = typeof file.fileSizeBytes === 'string' ? Number(file.fileSizeBytes) : file.fileSizeBytes
      const size = Number.isFinite(rawSize) && (rawSize as number) > 0 ? Number(rawSize) : 0
      return total + size
    }, 0)
  }, [groups, selectedFileIds])
  const visibleFiles = openFolder
    ? openUploadsRoot
      ? rootUploadGroups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
      : filesInOpenFolder
    : [...projectRootGroups, ...rootUploadsSectionGroups].flatMap((group) => [
        ...(group.mainFile ? [group.mainFile] : []),
        ...group.subFiles,
      ])
  // A video folder's detail view has no multi-select: its hero offers "Download video" and
  // "Everything", and each asset row its own Download. The toolbar's selection controls are
  // hidden there, because a selection the page can't show (the hero has no checkbox, other
  // versions aren't part of the delivery) only made the "N files selected" count confusing.
  const isVideoFolderView = openFolder?.groupType === 'video'
  const selectedUploadFilesInContext = useMemo(() => {
    if (!isUploadsContext) return [] as DownloadableFile[]
    return visibleFiles.filter((file) => file.type === 'upload-file' && selectedFileIds.has(getDownloadableFileKey(file)))
  }, [isUploadsContext, visibleFiles, selectedFileIds])

  useEffect(() => {
    // Keep selection valid across folder changes without dropping items selected from other sections.
    const selectableKeys = new Set(
      groups
        .flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
        .filter((file) => isSelectableDownloadableFile(file, isAdmin))
        .map((file) => getDownloadableFileKey(file))
    )

    setSelectedFileIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((key) => selectableKeys.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [groups, setSelectedFileIds, isAdmin])

  // When no folder is open (root PROJECT view), "Select all" selects every file
  // across all groups — matching the sidebar's Select All behavior.
  const rootViewAllKeys = useMemo(() => {
    if (openFolder) return null
    return groups
      .flatMap((g) => getGroupSelectableFiles(g, isAdmin))
      .map(getDownloadableFileKey)
  }, [openFolder, groups, isAdmin])

  const selectAllVisible = () => {
    if (rootViewAllKeys) {
      setSelectedFileIds((prev) => {
        const next = new Set(prev)
        rootViewAllKeys.forEach((key) => next.add(key))
        return next
      })
      return
    }
    const visibleKeys = visibleFiles
      .filter((file) => isSelectableDownloadableFile(file, isAdmin))
      .map(getDownloadableFileKey)
    if (!visibleKeys.length) return

    setSelectedFileIds((prev) => {
      const next = new Set(prev)
      visibleKeys.forEach((key) => next.add(key))
      return next
    })
  }

  const clearSelection = () => {
    setSelectedFileIds(new Set())
  }

  const allVisibleSelected = useMemo(() => {
    if (rootViewAllKeys) {
      return rootViewAllKeys.length > 0 && rootViewAllKeys.every((key) => selectedFileIds.has(key))
    }
    const visibleSelectableKeys = visibleFiles
      .filter((file) => isSelectableDownloadableFile(file, isAdmin))
      .map(getDownloadableFileKey)
    return visibleSelectableKeys.length > 0 && visibleSelectableKeys.every((key) => selectedFileIds.has(key))
  }, [rootViewAllKeys, visibleFiles, selectedFileIds, isAdmin])

  const toggleAllVisibleSelection = () => {
    if (allVisibleSelected) {
      clearSelection()
      return
    }
    selectAllVisible()
  }

  const downloadSelected = async () => {
    // When in the UPLOADS root view, subfolders are separate groups — include files from all
    // upload groups so selections spanning subfolders are fully represented.
    const scopedFiles = openFolder
      ? openUploadsRoot
        ? rootUploadGroups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
        : filesInOpenFolder
      : groups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
    const selectedFiles = scopedFiles.filter((file) => selectedFileIds.has(getDownloadableFileKey(file)))
    await downloadFileSet(selectedFiles)
  }

  // Bulk-download a set of files: ZIP when small enough, otherwise a folder download
  // (File System Access) or one-by-one, via the page's transfer hook.
  const downloadFileSet = async (files: DownloadableFile[]) => {
    const selectedFiles = files.filter((file) => file.type !== 'video' || isAdmin || file.isApproved !== false)
    if (!selectedFiles.length) return
    const totalSizeBytes = selectedFiles.reduce((total, file) => total + getFileSizeBytes(file), 0)

    // Annotate each file with the FSA download folder path so runBulkFsaDownload can
    // recreate the group/folder structure inside the user-chosen directory.
    const fileKeyToGroup = new Map<string, (typeof groups)[number]>()
    for (const group of groups) {
      for (const file of [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]) {
        fileKeyToGroup.set(getDownloadableFileKey(file), group)
      }
    }
    const annotatedFiles = selectedFiles.map((file) => {
      const group = fileKeyToGroup.get(getDownloadableFileKey(file))
      if (!group) return file
      if (group.groupType === 'uploads') {
        // Place uploads under an "UPLOADS" top-level folder, with any subfolder path beneath it.
        const parts = ['UPLOADS', ...(file.uploadFolderPath?.split('/').filter(Boolean) ?? [])]
        return { ...file, downloadFolderPath: parts.join('/') }
      }
      // Video / album groups → folder named after the group
      return { ...file, downloadFolderPath: group.name }
    })

    // If the selection exceeds the bulk-download threshold but the browser doesn't support
    // the File System Access API (Firefox, Safari), show a "use Chrome or Edge" advisory.
    const isBulkThreshold = totalSizeBytes > ZIP_DOWNLOAD_THRESHOLD_BYTES
    const isFsaAvailable = typeof window !== 'undefined' && 'showDirectoryPicker' in window
    if (isBulkThreshold && !isFsaAvailable) {
      setBulkFsaUnsupportedFiles(annotatedFiles)
      return
    }

    setIsDownloadingSelected(true)
    setLocalDownloadProgress(null)
    try {
      if (onDownloadFiles) {
        await onDownloadFiles(annotatedFiles, (progress) => setLocalDownloadProgress(progress))
      } else {
        await Promise.all(annotatedFiles.map((file) => onDownloadFile(file).catch(() => undefined)))
      }
    } finally {
      setIsDownloadingSelected(false)
      setLocalDownloadProgress(null)
    }
  }

  const isDownloadBusy = isDownloadingSelected
  const activeProgress = localDownloadProgress

  const runCreateUploadFolder = useCallback(() => {
    if (!canUploadToProjects || !onCreateUploadFolder || isUploadActionBusy) return
    setShowCreateFolderDialog(true)
  }, [canUploadToProjects, onCreateUploadFolder, isUploadActionBusy])

  const confirmCreateUploadFolder = useCallback(async (folderName: string) => {
    if (!onCreateUploadFolder) return
    setIsUploadActionBusy(true)
    try {
      await onCreateUploadFolder(uploadsTargetFolderPath, folderName)
      setShowCreateFolderDialog(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to create folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [onCreateUploadFolder, uploadsTargetFolderPath])

  const openUploadFilePicker = useCallback(() => {
    if (!canUploadToProjects || !onUploadFiles || isUploadActionBusy) return
    setPendingUploadFolderPath(uploadsTargetFolderPath)
    uploadInputRef.current?.click()
  }, [canUploadToProjects, onUploadFiles, isUploadActionBusy, uploadsTargetFolderPath])

  const deleteSelectedUploadFiles = useCallback(() => {
    if (!canDeleteUploads || !onDeleteUploadFile || isUploadActionBusy) return
    if (selectedUploadFilesInContext.length === 0) return
    setShowDeleteSelectedDialog(true)
  }, [canDeleteUploads, onDeleteUploadFile, isUploadActionBusy, selectedUploadFilesInContext])

  const confirmDeleteSelectedUploadFiles = useCallback(async () => {
    if (!onDeleteUploadFile) return
    setIsUploadActionBusy(true)
    try {
      for (const file of selectedUploadFilesInContext) {
        if (!file.uploadFileId) continue
        await onDeleteUploadFile(file.uploadFileId)
      }
      const deletedKeys = new Set(selectedUploadFilesInContext.map((file) => getDownloadableFileKey(file)))
      setSelectedFileIds((prev) => new Set(Array.from(prev).filter((key) => !deletedKeys.has(key))))
      setShowDeleteSelectedDialog(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete selected files')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [onDeleteUploadFile, selectedUploadFilesInContext, setSelectedFileIds])

  const submitUploadFiles = useCallback(async (folderPath: string, files: File[]) => {
    if (!canUploadToProjects || !onUploadFiles || !Array.isArray(files) || files.length === 0) return
    setIsUploadActionBusy(true)
    try {
      await onUploadFiles(folderPath, files)
    } catch {
      // Upload errors are shown in the transfer UI; avoid duplicate modal alerts.
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [canUploadToProjects, onUploadFiles])

  const hasDraggedFiles = useCallback((event: React.DragEvent) => {
    const types = Array.from(event.dataTransfer?.types || [])
    return types.includes('Files')
  }, [])

  const allowUploadDrop = useCallback((event: React.DragEvent) => {
    if (!hasDraggedFiles(event)) return false
    if (!canUploadToProjects || !onUploadFiles || isUploadActionBusy) return false
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy'
    }
    return true
  }, [canUploadToProjects, onUploadFiles, isUploadActionBusy, hasDraggedFiles])

  const deleteUploadFile = useCallback((fileId: string) => {
    if (!canDeleteUploads || !onDeleteUploadFile || !fileId || isUploadActionBusy) return
    setPendingDeleteFileId(fileId)
  }, [canDeleteUploads, onDeleteUploadFile, isUploadActionBusy])

  const confirmDeleteUploadFile = useCallback(async () => {
    if (!onDeleteUploadFile || !pendingDeleteFileId) return
    setIsUploadActionBusy(true)
    try {
      await onDeleteUploadFile(pendingDeleteFileId)
      setPendingDeleteFileId(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete file')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [onDeleteUploadFile, pendingDeleteFileId])

  const deleteUploadFolder = useCallback((folderPath: string) => {
    if (!canDeleteUploads || !onDeleteUploadFolder || !folderPath || isUploadActionBusy) return
    setPendingDeleteFolderPath(folderPath)
  }, [canDeleteUploads, onDeleteUploadFolder, isUploadActionBusy])

  const confirmDeleteUploadFolder = useCallback(async () => {
    if (!onDeleteUploadFolder || !pendingDeleteFolderPath) return
    setIsUploadActionBusy(true)
    try {
      await onDeleteUploadFolder(pendingDeleteFolderPath)
      setPendingDeleteFolderPath(null)
      // Don't force-navigate to root here. If the deleted folder is the one we're
      // viewing, the cleanup effect resets openFolderName once it leaves sortedGroups.
      // Forcing null while the parent still requests this folder makes the parent↔child
      // folder-sync effects oscillate (openFolderName ⇄ requested) and trip React's
      // "maximum update depth" (#185). Deleting a subfolder now keeps you in the parent.
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [onDeleteUploadFolder, pendingDeleteFolderPath])

  const renameUploadFolder = useCallback((folderPath: string, currentFolderName: string) => {
    if (!canDeleteUploads || !onRenameUploadFolder || !folderPath || isUploadActionBusy) return
    setRenameFolderTarget({ path: folderPath, name: currentFolderName })
    setShowRenameFolderDialog(true)
  }, [canDeleteUploads, onRenameUploadFolder, isUploadActionBusy])

  const confirmRenameUploadFolder = useCallback(async (newName: string) => {
    if (!onRenameUploadFolder || !renameFolderTarget) return
    if (newName === renameFolderTarget.name) { setShowRenameFolderDialog(false); return }
    setIsUploadActionBusy(true)
    try {
      await onRenameUploadFolder(renameFolderTarget.path, newName)
      setShowRenameFolderDialog(false)
      setRenameFolderTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to rename folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [onRenameUploadFolder, renameFolderTarget])

  const compareFileNameAsc = useCallback((a: DownloadableFile, b: DownloadableFile) => {
    return String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, { sensitivity: 'base' })
  }, [])

  const getVideoVersionNumber = useCallback((file: DownloadableFile): number | null => {
    const label = String(file.versionLabel || '').trim()
    if (!label) return null
    const match = label.match(/\d+/)
    if (!match) return null
    const value = Number(match[0])
    return Number.isFinite(value) ? value : null
  }, [])

  const compareVideoVersionDesc = useCallback((a: DownloadableFile, b: DownloadableFile) => {
    const av = getVideoVersionNumber(a)
    const bv = getVideoVersionNumber(b)
    if (av != null && bv != null && av !== bv) {
      return bv - av
    }
    if (av != null && bv == null) return -1
    if (av == null && bv != null) return 1
    return compareFileNameAsc(a, b)
  }, [compareFileNameAsc, getVideoVersionNumber])

  const handleApproveVideo = useCallback(async () => {
    const file = approveConfirmFile
    if (!file || !onApproveVideo) return
    if (approvingRef.current) return
    approvingRef.current = true
    setApproving(true)
    try {
      await onApproveVideo(file)
      setApproveConfirmFile(null)
      setApproveConfirmVideoName('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Approval failed')
    } finally {
      approvingRef.current = false
      setApproving(false)
    }
  }, [approveConfirmFile, onApproveVideo])

  const handleRequestNextVersion = useCallback(async () => {
    const file = requestNextFile
    if (!file || !onRequestNextVersion) return
    if (requestingNextRef.current) return
    requestingNextRef.current = true
    setRequestingNext(true)
    try {
      await onRequestNextVersion(file)
      setRequestNextFile(null)
      toast.success('Next version requested')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Request failed')
    } finally {
      requestingNextRef.current = false
      setRequestingNext(false)
    }
  }, [requestNextFile, onRequestNextVersion])

  const openFolderVideoVersions = useMemo(() => {
    if (openFolder?.groupType !== 'video') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'video')].sort(compareVideoVersionDesc)
  }, [openFolder?.groupType, filesInOpenFolder, compareVideoVersionDesc])

  const openFolderVideoAssets = useMemo(() => {
    if (openFolder?.groupType !== 'video') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'asset')].sort(compareFileNameAsc)
  }, [openFolder?.groupType, filesInOpenFolder, compareFileNameAsc])

  const openFolderApprovedVideoVersion = useMemo(() => {
    if (openFolder?.groupType !== 'video') return null
    return openFolderVideoVersions.find((file) => file.isApproved === true) ?? null
  }, [openFolder?.groupType, openFolderVideoVersions])


  const openFolderAlbumZips = useMemo(() => {
    if (openFolder?.groupType !== 'album') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'album-zip')].sort(compareFileNameAsc)
  }, [openFolder?.groupType, filesInOpenFolder, compareFileNameAsc])

  const openFolderAlbumPhotos = useMemo(() => {
    if (openFolder?.groupType !== 'album') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'album-photo')].sort(compareFileNameAsc)
  }, [openFolder?.groupType, filesInOpenFolder, compareFileNameAsc])

  const openFolderUploadFiles = useMemo(() => {
    if (openFolder?.groupType !== 'uploads') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'upload-file')].sort(compareFileNameAsc)
  }, [openFolder?.groupType, filesInOpenFolder, compareFileNameAsc])
  // Immediate child folders of whichever uploads folder is currently open (the UPLOADS
  // root or a nested folder). Groups are flat with hierarchical names, so a plain
  // "everything except UPLOADS" list renders deep subfolders as flat siblings (e.g.
  // "TEST" and "TEST/TEST 2" side by side at the root). Like a real file browser, show
  // only the folders exactly one level below the open one.
  const childUploadFolders = useMemo(() => {
    if (!isUploadsContext) return [] as DownloadableGroup[]
    const currentSegments = uploadsTargetFolderPath
      ? uploadsTargetFolderPath.split('/').map((segment) => segment.trim()).filter(Boolean)
      : []
    const currentDepth = currentSegments.length
    return rootUploadGroups.filter((group) => {
      if (group.name === 'UPLOADS') return false
      const relativePath = getUploadsFolderPathFromGroup(group.name)
      if (!relativePath) return false
      const segments = relativePath.split('/').map((segment) => segment.trim()).filter(Boolean)
      // Exactly one level below the open folder, and sharing its full path as a prefix.
      if (segments.length !== currentDepth + 1) return false
      return currentSegments.every((segment, index) => segments[index] === segment)
    })
  }, [isUploadsContext, uploadsTargetFolderPath, rootUploadGroups, getUploadsFolderPathFromGroup])

  // Ensure child folder group names are present in visibleFolderNames so the preview-tile
  // effect fires for them. The IntersectionObserver handles this too, but there is a
  // timing gap between card mount and the first observer callback that can leave the
  // folders invisible to the effect on the first render pass.
  useEffect(() => {
    if (childUploadFolders.length === 0) return
    setVisibleFolderNames((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const group of childUploadFolders) {
        if (!next.has(group.name)) {
          next.add(group.name)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [childUploadFolders])
  const pendingUploadTransferByFileId = useMemo(() => {
    const map = new Map<string, TransferItem>()
    for (const transfer of transferItems) {
      if (transfer.direction !== 'upload') continue
      const pendingId = `pending-${transfer.id}`
      map.set(pendingId, transfer)
    }
    return map
  }, [transferItems])
  const videoAssetsSelection = getSubsetSelectionState(openFolderVideoAssets)
  const albumPhotosSelection = getSubsetSelectionState(openFolderAlbumPhotos)
  const uploadFilesSelection = getSubsetSelectionState(openFolderUploadFiles)

  // Returns the best available full-resolution URL for a file in the lightbox.
  const getLightboxUrl = (file: DownloadableFile): string | null => {
    if (file.type === 'album-photo') {
      // Prefer social-sized preview (higher res than thumbnail)
      return file.previewUrl || file.downloadUrl || file.thumbnailUrl || null
    }
    if (file.type === 'asset' && getDownloadableFileKind(file) === 'video') {
      return videoPlaybackUrlByFileKey[getDownloadableFileKey(file)] || null
    }
    const resolved = previewUrlByFileKey[getDownloadableFileKey(file)]
    return (typeof resolved === 'string' && resolved.length > 0) ? resolved : (file.thumbnailUrl || file.previewUrl || null)
  }

  const getAudioPlaybackUrl = useCallback(async (file: DownloadableFile): Promise<string | null> => {
    const fileKey = getDownloadableFileKey(file)
    const cached = audioPlaybackUrlByFileKey[fileKey]
    if (cached !== undefined) return cached

    if (typeof file.downloadUrl === 'string' && file.downloadUrl.length > 0) {
      setAudioPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: file.downloadUrl! }))
      return file.downloadUrl
    }

    const inFlight = audioPlaybackRequestRef.current.get(fileKey)
    if (inFlight) return inFlight

    if (!resolveFilePlaybackUrl) {
      setAudioPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
      return null
    }

    const request = resolveFilePlaybackUrl(file)
      .then((url) => {
        const resolved = typeof url === 'string' && url.length > 0 ? url : null
        setAudioPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: resolved }))
        return resolved
      })
      .catch(() => {
        setAudioPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
        return null
      })
      .finally(() => {
        audioPlaybackRequestRef.current.delete(fileKey)
      })

    audioPlaybackRequestRef.current.set(fileKey, request)
    return request
  }, [audioPlaybackUrlByFileKey, resolveFilePlaybackUrl])

  const getVideoPlaybackUrl = useCallback(async (file: DownloadableFile): Promise<string | null> => {
    const fileKey = getDownloadableFileKey(file)
    const cached = videoPlaybackUrlByFileKey[fileKey]
    if (cached !== undefined) return cached

    const inFlight = videoPlaybackRequestRef.current.get(fileKey)
    if (inFlight) return inFlight

    if (!resolveFilePlaybackUrl) {
      setVideoPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
      return null
    }

    const request = resolveFilePlaybackUrl(file)
      .then((url) => {
        const resolved = typeof url === 'string' && url.length > 0 ? url : null
        setVideoPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: resolved }))
        return resolved
      })
      .catch(() => {
        setVideoPlaybackUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
        return null
      })
      .finally(() => {
        videoPlaybackRequestRef.current.delete(fileKey)
      })

    videoPlaybackRequestRef.current.set(fileKey, request)
    return request
  }, [resolveFilePlaybackUrl, videoPlaybackUrlByFileKey])

  const openImageLightbox = (file: DownloadableFile, imageList: DownloadableFile[]) => {
    if (getDownloadableFileKind(file) !== 'image') return
    if (file.type === 'album-photo') {
      const imageOnly = imageList.filter((f) => getDownloadableFileKind(f) === 'image')
      const albumPhotoList = imageOnly.filter((f) => f.type === 'album-photo')
      const albumIndex = albumPhotoList.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
      setAlbumViewerState({
        images: albumPhotoList,
        currentIndex: Math.max(0, albumIndex),
        albumId: typeof file.albumId === 'string' ? file.albumId : null,
      })
      return
    }

    const mediaItems = imageList.filter(isLightboxMediaFile)
    const source = mediaItems.length > 0 ? mediaItems : [file]
    const index = source.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
    setLightboxState({ images: source, currentIndex: Math.max(0, index) })
  }

  const openVideoLightbox = useCallback((file: DownloadableFile, fileList: DownloadableFile[]) => {
    if (getDownloadableFileKind(file) !== 'video' || file.type === 'video') return
    // No playable preview (purged on close) — don't open an empty player.
    if (isAssetPlaybackPurged(file)) return

    const mediaItems = fileList.filter(isLightboxMediaFile)
    const source = mediaItems.length > 0 ? mediaItems : [file]
    const index = source.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
    const safeIndex = Math.max(0, index)
    const target = source[safeIndex]
    if (target && getDownloadableFileKind(target) === 'audio') {
      setAudioLightboxState({ files: source, currentIndex: safeIndex })
      return
    }
    setLightboxState({ images: source, currentIndex: safeIndex })
  }, [])

  const openAudioLightbox = useCallback((file: DownloadableFile, fileList: DownloadableFile[]) => {
    if (getDownloadableFileKind(file) !== 'audio') return

    const mediaItems = fileList.filter(isLightboxMediaFile)
    const source = mediaItems.length > 0 ? mediaItems : [file]
    const index = source.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
    setAudioLightboxState({ files: source, currentIndex: Math.max(0, index) })
  }, [])

  const openDocumentViewer = useCallback((file: DownloadableFile, fileList: DownloadableFile[]) => {
    if (!resolveDocumentViewUrl || !isViewableDocumentFile(file)) return

    // Page through the other viewable documents in the same folder, mirroring how the image
    // lightbox pages through its siblings.
    const documents = fileList.filter(isViewableDocumentFile)
    const source = documents.length > 0 ? documents : [file]
    const index = source.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
    setDocumentViewerState({ files: source, currentIndex: Math.max(0, index) })
  }, [resolveDocumentViewUrl])

  const navigateMixedLightbox = useCallback((delta: number) => {
    if (lightboxState) {
      const next = (lightboxState.currentIndex + delta + lightboxState.images.length) % lightboxState.images.length
      const nextFile = lightboxState.images[next]
      if (nextFile && getDownloadableFileKind(nextFile) === 'audio') {
        setLightboxState(null)
        setAudioLightboxState({ files: lightboxState.images, currentIndex: next })
        return
      }
      setLightboxState({ ...lightboxState, currentIndex: next })
      return
    }

    setAudioLightboxState((prev) => {
      if (!prev) return prev
      const next = (prev.currentIndex + delta + prev.files.length) % prev.files.length
      const nextFile = prev.files[next]
      if (nextFile && getDownloadableFileKind(nextFile) !== 'audio') {
        setLightboxState({ images: prev.files, currentIndex: next })
        return null
      }
      return { ...prev, currentIndex: next }
    })
  }, [lightboxState])

  const albumViewerNavigate = (delta: number) => {
    setAlbumViewerState((prev) => {
      if (!prev) return prev
      const next = (prev.currentIndex + delta + prev.images.length) % prev.images.length
      return { ...prev, currentIndex: next }
    })
  }

  const triggerDirectDownload = (url: string) => {
    const link = document.createElement('a')
    link.href = url
    link.rel = 'noopener'
    link.download = ''
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const loadAlbumPhotoMeta = useCallback(async (albumId: string | null) => {
    if (!albumId || !shareSlug) return
    if (albumMetaLoadedByAlbumId[albumId]) return

    try {
      const res = await apiFetch(`/api/share/${encodeURIComponent(shareSlug)}/albums/${encodeURIComponent(albumId)}`, {
        cache: 'no-store',
        headers: shareToken ? { Authorization: `Bearer ${shareToken}` } : undefined,
      })
      if (!res.ok) return

      const data = await res.json().catch(() => ({}))
      const photos = Array.isArray((data as any)?.photos) ? (data as any).photos : []
      const socialEnabled = (data as any)?.album?.socialCopiesEnabled !== false

      setAlbumMetaLoadedByAlbumId((prev) => ({ ...prev, [albumId]: true }))
      setAlbumSocialEnabledByAlbumId((prev) => ({ ...prev, [albumId]: socialEnabled }))
      setAlbumPhotoMetaByPhotoId((prev) => {
        const next = { ...prev }
        for (const photo of photos) {
          const photoId = typeof photo?.id === 'string' ? photo.id : ''
          const socialDownloadUrl = typeof photo?.socialDownloadUrl === 'string' ? photo.socialDownloadUrl : ''
          if (!photoId || !socialDownloadUrl) continue
          next[photoId] = {
            socialDownloadUrl,
            socialReady: photo?.socialReady === true,
          }
        }
        return next
      })
    } catch {
      // Ignore errors; retry on next trigger.
    }
  }, [albumMetaLoadedByAlbumId, shareSlug, shareToken])

  useEffect(() => {
    if (!lightboxState) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') navigateMixedLightbox(-1)
      else if (event.key === 'ArrowRight') navigateMixedLightbox(1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxState, navigateMixedLightbox])

  useEffect(() => {
    if (!albumViewerState) return
    void loadAlbumPhotoMeta(albumViewerState.albumId)
  }, [albumViewerState, loadAlbumPhotoMeta])

  // Preload album photo meta for all album groups (so right-click context menu has social data)
  useEffect(() => {
    if (!shareSlug) return
    for (const group of groups) {
      if (group.groupType === 'album') {
        for (const file of group.subFiles) {
          if (file.albumId) {
            void loadAlbumPhotoMeta(file.albumId)
            break
          }
        }
      }
    }
  }, [groups, loadAlbumPhotoMeta, shareSlug])

  useEffect(() => {
    if (!albumViewerState) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') albumViewerNavigate(-1)
      else if (event.key === 'ArrowRight') albumViewerNavigate(1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumViewerState !== null])

  useEffect(() => {
    if (!audioLightboxState) return
    const currentFile = audioLightboxState.files[audioLightboxState.currentIndex]
    if (!currentFile) return
    void getAudioPlaybackUrl(currentFile)
  }, [audioLightboxState, getAudioPlaybackUrl])

  useEffect(() => {
    if (!lightboxState) return
    const currentFile = lightboxState.images[lightboxState.currentIndex]
    if (!currentFile) return
    if (currentFile.type === 'asset' && getDownloadableFileKind(currentFile) === 'video') {
      void getVideoPlaybackUrl(currentFile)
    }
  }, [getVideoPlaybackUrl, lightboxState])

  useEffect(() => {
    if (!audioLightboxState) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') navigateMixedLightbox(-1)
      else if (event.key === 'ArrowRight') navigateMixedLightbox(1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [audioLightboxState, navigateMixedLightbox])

  useEffect(() => {
    const requestedKey = String(requestedOpenFileKey || '').trim()
    if (!requestedKey) return
    if (!openFolder) return

    const requestedFile = filesInOpenFolder.find((file) => getDownloadableFileKey(file) === requestedKey)
    if (requestedFile && getDownloadableFileKind(requestedFile) === 'image') {
      const imageList = requestedFile.type === 'album-photo' ? openFolderAlbumPhotos : openFolderVideoAssets
      openImageLightbox(requestedFile, imageList)
    } else if (requestedFile && getDownloadableFileKind(requestedFile) === 'video' && requestedFile.type === 'asset') {
      openVideoLightbox(requestedFile, openFolderVideoAssets)
    } else if (requestedFile && getDownloadableFileKind(requestedFile) === 'audio') {
      const audioList = openFolder?.groupType === 'uploads'
        ? openFolderUploadFiles
        : openFolder?.groupType === 'video'
          ? openFolderVideoAssets
          : filesInOpenFolder
      openAudioLightbox(requestedFile, audioList)
    }

    onOpenFileKeyHandled?.()
  }, [
    requestedOpenFileKey,
    openFolder,
    filesInOpenFolder,
    openFolderAlbumPhotos,
    openFolderUploadFiles,
    openFolderVideoAssets,
    openVideoLightbox,
    openAudioLightbox,
    onOpenFileKeyHandled,
  ])

  const renderOpenFolderFileCard = (file: DownloadableFile, compact = false, imageList: DownloadableFile[] = []) => {
    const fileKey = getDownloadableFileKey(file)
    const FileTypeIcon = getFileTypeIcon(file)
    const fileKind = getDownloadableFileKind(file)
    const isImageFile = fileKind === 'image'
    const isAudioFile = fileKind === 'audio'
    const isVideoAssetFile = fileKind === 'video' && file.type === 'asset'
    const isPlaybackPurgedAsset = isAssetPlaybackPurged(file)
    const isSelected = selectedFileIds.has(fileKey)
    const resolvedPreview = previewUrlByFileKey[fileKey]
    const inlinePreview = file.thumbnailUrl || file.previewUrl || null
    const previewSrc = (typeof resolvedPreview === 'string' && resolvedPreview.length > 0)
      ? resolvedPreview
      : (typeof inlinePreview === 'string' && inlinePreview.length > 0 ? inlinePreview : null)
    const showImagePreview = typeof previewSrc === 'string' && previewSrc.length > 0
    const hasMultipleVideoVersionsInOpenFolder = openFolderVideoVersions.length > 1
    const showVideoPreview =
      file.type === 'video' &&
      !hasMultipleVideoVersionsInOpenFolder &&
      Boolean(folderPreviewByName?.[openFolder?.name || ''])
    // Determine timeline hover preview eligibility — works for videos, assets, and uploads
    // videoThumbnailSrc may be empty for upload/asset videos whose image preview
    // is still processing while timeline sprites are already ready (separate jobs).
    const videoThumbnailSrc = showImagePreview ? previewSrc : showVideoPreview ? (folderPreviewByName?.[openFolder?.name || ''] || '') : null
    const showTimelineHover =
      file.hasTimelinePreviews === true &&
      typeof file.timelineVttUrl === 'string' &&
      file.timelineVttUrl.length > 0 &&
      typeof file.timelineSpriteBaseUrl === 'string' &&
      file.timelineSpriteBaseUrl.length > 0 &&
      typeof file.durationSeconds === 'number' &&
      file.durationSeconds > 0
    const sizeLabel = formatFileSize(file.fileSizeBytes)
    const durationLabel = fileKind === 'video'
      ? formatDuration(file.durationSeconds ?? derivedVideoDurationByFileKey[fileKey] ?? undefined)
      : null
    const fileExtensionLabel = getFileExtensionLabel(file.fileName)
    const canDownloadFile = file.type !== 'video' || isAdmin || file.isApproved !== false
    const canSelectFile = isSelectableDownloadableFile(file, isAdmin)
    const displayFileName = file.type === 'video'
      ? `${openFolder?.name || file.fileName} - ${file.versionLabel || 'Version'}`
      : file.fileName
    const latestVideoVersionKey = openFolderVideoVersions.length > 0
      ? getDownloadableFileKey(openFolderVideoVersions[0])
      : null
    const showReviewedBadge = file.type === 'video' && file.isApproved === false && file.isRevisionRequested === true && latestVideoVersionKey === fileKey
    const showForReviewBadge = file.type === 'video' && file.isApproved === false && latestVideoVersionKey === fileKey && !showReviewedBadge
    const videoVersionsInGroup = imageList.filter((entry) => entry.type === 'video')
    const hasMultipleVideoVersions = videoVersionsInGroup.length > 1
    const hasApprovedVideoVersionInGroup = videoVersionsInGroup.some((entry) => entry.isApproved === true)
    const muteInactiveVideoVersion =
      file.type === 'video' &&
      hasMultipleVideoVersions &&
      hasApprovedVideoVersionInGroup &&
      file.isApproved !== true
    // Admins can still interact with muted versions; clients are fully blocked.
    const blockInactiveVideoInteraction = muteInactiveVideoVersion && !isAdmin
    const uploadTransfer = file.type === 'upload-file' && file.uploadFileId
      ? pendingUploadTransferByFileId.get(file.uploadFileId)
      : null
    const uploadProgressPercent = uploadTransfer ? Math.max(0, Math.min(100, Math.round(uploadTransfer.progressPercent))) : null
    const uploadStatusLabel = uploadTransfer
      ? uploadTransfer.status === 'completed'
        ? 'Uploaded'
        : uploadTransfer.status === 'failed'
          ? 'Upload failed'
          : uploadTransfer.status === 'canceled'
            ? 'Upload canceled'
            : uploadTransfer.status === 'preparing'
              ? 'Preparing upload'
              : uploadTransfer.status === 'transferring'
                ? 'Uploading'
                : 'Queued for upload'
      : null
    const keepActionsOnTitleRow = file.type === 'video'
    const showApproveButton =
      file.type === 'video' &&
      file.isApproved === false &&
      file.allowApproval === true &&
      // Once the next version is requested, approval of that version is off the table.
      file.isRevisionRequested !== true &&
      onApproveVideo &&
      !muteInactiveVideoVersion &&
      !groupHasApprovedVersion
    const showPlayableVideoOverlay = !isPlaybackPurgedAsset && (isVideoAssetFile || (file.type === 'video' && (!muteInactiveVideoVersion || isAdmin))) && (showImagePreview || showVideoPreview)
    const actionButtons = canDownloadFile ? (
      <div className="flex items-center gap-1">
        {file.type === 'upload-file' && canDeleteUploads && onDeleteUploadFile && file.uploadFileId ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-7 w-7')}
            disabled={isUploadActionBusy}
            onClick={(event) => { event.stopPropagation(); void deleteUploadFile(file.uploadFileId!) }}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label={`Delete ${file.fileName}`}
            title={`Delete ${file.fileName}`}
          >
            <Trash2 className={cn(compact ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="default"
          size="icon"
          className={cn('shrink-0 bg-primary text-primary-foreground hover:bg-primary/90', compact ? 'h-6 w-6' : 'h-7 w-7')}
          disabled={blockInactiveVideoInteraction}
          onClick={(event) => { event.stopPropagation(); void onDownloadFile(file) }}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={`Download ${file.fileName}`}
          title={`Download ${file.fileName}`}
        >
          <Download className={cn(compact ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
        </Button>
      </div>
    ) : showApproveButton ? (
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="success"
          size="icon"
          className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-7 w-7')}
          disabled={approving}
          onClick={(event) => { event.stopPropagation(); setApproveConfirmFile(file); setApproveConfirmVideoName(openFolder?.name || file.fileName) }}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={`Approve ${displayFileName}`}
          title={`Approve ${displayFileName}`}
        >
          <Check className={cn(compact ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
        </Button>
      </div>
    ) : null

    return (
      <div
        key={fileKey}
        ref={(node) => registerFilePreviewCardRef(fileKey, node)}
        data-file-preview-key={fileKey}
        className={cn(
          'rounded-xl bg-card transition-colors overflow-hidden shadow-sm',
          (isImageFile || isAudioFile) && 'cursor-zoom-in',
          isViewableDocumentFile(file) && resolveDocumentViewUrl && 'cursor-pointer',
          muteInactiveVideoVersion && 'opacity-55 saturate-0',
          isSelected
            ? 'border-2 border-primary/85 hover:border-primary'
            : 'border border-border hover:border-primary/45'
        )}
        onClick={() => {
          if (blockInactiveVideoInteraction) return
          if (isViewableDocumentFile(file) && resolveDocumentViewUrl) {
            openDocumentViewer(file, imageList)
            return
          }
          if (file.type === 'upload-file') return
          if (file.type === 'video' && file.videoId && onOpenVideoVersion) {
            onOpenVideoVersion(file, openFolder?.name || null)
            return
          }
          if (isImageFile) {
            openImageLightbox(file, imageList)
            return
          }
          if (fileKind === 'video' && file.type !== 'video') {
            openVideoLightbox(file, imageList)
            return
          }
          if (isAudioFile) {
            openAudioLightbox(file, imageList)
          }
        }}
        onDoubleClick={() => {
          if (blockInactiveVideoInteraction) return
          if (file.type === 'upload-file') {
            if (!canDownloadFile) return
            void onDownloadFile(file)
            return
          }
          if (file.type === 'video' && file.videoId && onOpenVideoVersion) {
            onOpenVideoVersion(file, openFolder?.name || null)
            return
          }
          if (fileKind === 'video' && file.type !== 'video') {
            openVideoLightbox(file, imageList)
            return
          }
          if (isAudioFile) {
            openAudioLightbox(file, imageList)
            return
          }
          if (!canDownloadFile) return
          void onDownloadFile(file)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({ x: event.clientX, y: event.clientY, file, imageList })
          // Trigger album photo meta load for social download (safety net)
          if (file.type === 'album-photo' && file.albumId) {
            void loadAlbumPhotoMeta(file.albumId)
          }
        }}
      >
        <div className={cn('relative bg-linear-to-b from-muted/70 to-muted/35', compact ? 'p-2 pb-1.5' : 'p-2.5 pb-2')}>
          <div className={cn('relative rounded-lg border border-border/80 bg-card shadow-inner shadow-black/10', compact ? 'p-1' : 'p-1.5')}>
            <div className={cn('relative rounded-md overflow-hidden bg-black/85', compact ? 'aspect-4/3' : 'aspect-16/10')}>
              {showTimelineHover ? (
                <VideoHoverPreview
                  key={fileKey}
                  thumbnailUrl={videoThumbnailSrc || ''}
                  vttUrl={file.timelineVttUrl!}
                  spriteBaseUrl={file.timelineSpriteBaseUrl!}
                  spriteUrls={file.timelineSpriteUrls}
                  durationSeconds={file.durationSeconds!}
                  alt={file.fileName}
                  className="w-full h-full"
                />
              ) : showImagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewSrc!}
                  alt={file.fileName}
                  className={cn('w-full h-full', file.type === 'album-photo' ? 'object-cover' : 'object-contain')}
                  loading="lazy"
                  onError={() => {
                    // Upload previews are short-lived token URLs; if a token expires while idle,
                    // clear the cached URL so the effect path requests a fresh token.
                    invalidatePreviewForFileKey(fileKey)
                    if (file.type === 'upload-file' && file.previewStatus !== 'FAILED') {
                      schedulePreviewRetry(fileKey)
                    }
                  }}
                />
              ) : showVideoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={folderPreviewByName?.[openFolder?.name || ''] || ''}
                  alt={file.fileName}
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FileTypeIcon className="w-10 h-10" />
                  {fileExtensionLabel ? (
                    <span className="text-[11px] font-semibold tracking-wide text-foreground/80">{fileExtensionLabel}</span>
                  ) : null}
                  {(file.previewStatus === 'PENDING' || file.previewStatus === 'PROCESSING') ? (
                    <span className="absolute bottom-2 left-0 right-0 flex justify-center">
                      <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] leading-tight text-white/80">
                        Generating preview…
                      </span>
                    </span>
                  ) : null}
                </div>
              )}

              {showPlayableVideoOverlay ? (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/65 text-white shadow-lg">
                    <Play className="h-5 w-5 fill-current" />
                  </span>
                </div>
              ) : null}

              {durationLabel ? (
                <div className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums">
                  {durationLabel}
                </div>
              ) : null}

              {file.type === 'video' && file.versionLabel ? (
                <div className="absolute top-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[16px] leading-none text-white font-medium">
                  {file.versionLabel}
                </div>
              ) : null}

              {file.type === 'video' && file.isApproved === true ? (
                <div className="absolute bottom-2 left-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[11px] leading-none text-white font-semibold tracking-wide">
                  APPROVED
                </div>
              ) : null}

              {showForReviewBadge ? (
                <div className="absolute bottom-2 left-2 rounded bg-primary px-1.5 py-0.5 text-[11px] leading-none text-primary-foreground font-semibold tracking-wide">
                  LATEST
                </div>
              ) : null}

              {showReviewedBadge ? (
                <div className="absolute bottom-2 left-2 rounded bg-primary px-1.5 py-0.5 text-[11px] leading-none text-primary-foreground font-semibold tracking-wide" title="Next version requested">
                  REVIEWED
                </div>
              ) : null}
            </div>

            <div className="absolute top-2 left-2">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={!canSelectFile || blockInactiveVideoInteraction}
                onChange={(event) => {
                  if (!canSelectFile || blockInactiveVideoInteraction) return
                  toggleFile(fileKey, event.target.checked)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className={cn(
                  'w-4 h-4',
                  FILES_CHECKBOX_CLASS,
                  canSelectFile && !blockInactiveVideoInteraction ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                )}
                aria-label={`Select ${file.fileName}`}
              />
            </div>
          </div>
        </div>

        <div className={cn(compact ? 'px-2 py-2' : 'px-3 py-2.5')}>
          <div className="flex items-start justify-between gap-2 min-w-0">
            <div className="flex items-start gap-2 min-w-0">
              <FileTypeIcon className={cn('text-muted-foreground shrink-0 mt-0.5', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
              <p
                className={cn(
                  'font-semibold text-foreground line-clamp-2 wrap-break-word',
                  compact ? 'text-xs min-h-[2rem]' : 'text-sm min-h-[2.5rem]'
                )}
                title={displayFileName}
              >
                {displayFileName}
              </p>
            </div>
            {keepActionsOnTitleRow ? <div className="shrink-0">{actionButtons}</div> : null}
          </div>
          <div className={cn('text-muted-foreground flex items-center justify-between gap-2', compact ? 'text-[11px] mt-1' : 'text-xs mt-1.5')}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">{sizeLabel || 'Size unavailable'}</span>
              {file.type === 'video' ? (
                <span className="min-w-0 truncate" title={file.fileName}>{file.fileName}</span>
              ) : null}
            </div>
            {!keepActionsOnTitleRow ? actionButtons : null}
          </div>
          {uploadTransfer && uploadProgressPercent !== null ? (
            <div className={cn('mt-1.5 space-y-1', compact ? 'text-[10px]' : 'text-[11px]')}>
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <div className="inline-flex items-center gap-1.5">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 text-[10px] font-semibold text-primary">
                    {uploadProgressPercent}
                  </span>
                  <span>{uploadStatusLabel}</span>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full transition-all',
                    uploadTransfer.status === 'failed'
                      ? 'bg-destructive'
                      : uploadTransfer.status === 'canceled'
                        ? 'bg-warning'
                        : 'bg-primary'
                  )}
                  style={{ width: `${uploadProgressPercent}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  // ── Video folder view ────────────────────────────────────────────────────────
  // One video (all its versions) laid out as a delivery page: a hero for the version
  // that matters (the approved one, else the latest), then either the extras that ship
  // with the approval or the version history to review/approve from.

  const getResolvedPreviewSrc = (file: DownloadableFile): string | null => {
    const resolved = previewUrlByFileKey[getDownloadableFileKey(file)]
    if (typeof resolved === 'string' && resolved.length > 0) return resolved
    const inline = file.thumbnailUrl || file.previewUrl || null
    return typeof inline === 'string' && inline.length > 0 ? inline : null
  }

  const fileHasTimelineHover = (file: DownloadableFile): boolean =>
    file.hasTimelinePreviews === true &&
    typeof file.timelineVttUrl === 'string' && file.timelineVttUrl.length > 0 &&
    typeof file.timelineSpriteBaseUrl === 'string' && file.timelineSpriteBaseUrl.length > 0 &&
    typeof file.durationSeconds === 'number' && file.durationSeconds > 0

  const renderMediaThumb = (
    file: DownloadableFile,
    options: { posterFallback?: string | null; scrub?: boolean; showPlay?: boolean; versionBadge?: boolean; iconClassName?: string } = {}
  ) => {
    const { posterFallback = null, scrub = true, showPlay = false, versionBadge = false, iconClassName = 'h-6 w-6' } = options
    const fileKey = getDownloadableFileKey(file)
    const posterSrc = getResolvedPreviewSrc(file) || posterFallback
    const FileTypeIcon = getFileTypeIcon(file)
    return (
      <>
        {scrub && fileHasTimelineHover(file) ? (
          <VideoHoverPreview
            // Keyed by file: the component caches the loaded VTT cues, and the
            // video detail view reuses this slot when switching videos — without
            // a key it kept scrubbing the previously viewed video's sprites.
            key={fileKey}
            thumbnailUrl={posterSrc || ''}
            vttUrl={file.timelineVttUrl!}
            spriteBaseUrl={file.timelineSpriteBaseUrl!}
            spriteUrls={file.timelineSpriteUrls}
            durationSeconds={file.durationSeconds!}
            alt={file.fileName}
            className="h-full w-full"
          />
        ) : posterSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={posterSrc}
            alt={file.fileName}
            className="h-full w-full object-contain"
            loading="lazy"
            onError={() => {
              if (file.type === 'video') {
                // Version posters come from a fixed map — re-resolving would return the
                // same broken URL, so settle on the icon instead of looping.
                setPreviewUrlByFileKey((prev) => (prev[fileKey] === null ? prev : { ...prev, [fileKey]: null }))
                return
              }
              invalidatePreviewForFileKey(fileKey)
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <FileTypeIcon className={iconClassName} />
          </div>
        )}
        {showPlay ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-white shadow-lg">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </div>
        ) : null}
        {versionBadge && file.versionLabel ? (
          <div className="pointer-events-none absolute right-2 top-2 rounded-md bg-black/80 px-1.5 py-0.5 text-sm font-semibold leading-tight text-white">
            {file.versionLabel}
          </div>
        ) : null}
      </>
    )
  }

  const isVersionApprovable = (file: DownloadableFile): boolean =>
    file.type === 'video' &&
    file.isApproved !== true &&
    file.allowApproval === true &&
    // Once the next version is requested, approval of that version is off the table.
    file.isRevisionRequested !== true &&
    // A signed-off project takes no further approvals (the approve API refuses them).
    !projectApproved &&
    Boolean(onApproveVideo) &&
    !groupHasApprovedVersion

  const watchVersion = (file: DownloadableFile) => {
    if (file.type !== 'video' || !file.videoId || !onOpenVideoVersion) return
    onOpenVideoVersion(file, openFolder?.name || null)
  }

  const requestApproveVersion = (file: DownloadableFile) => {
    if (approving) return
    setApproveConfirmFile(file)
    setApproveConfirmVideoName(openFolder?.name || file.fileName)
  }

  const getAssetOpenMode = (file: DownloadableFile): 'play' | 'view' | null => {
    const kind = getDownloadableFileKind(file)
    if (kind === 'video') return isAssetPlaybackPurged(file) ? null : 'play'
    if (kind === 'audio') return 'play'
    if (kind === 'image') return 'view'
    if (isViewableDocumentFile(file) && resolveDocumentViewUrl) return 'view'
    return null
  }

  const openAsset = (file: DownloadableFile, list: DownloadableFile[]) => {
    const kind = getDownloadableFileKind(file)
    if (isViewableDocumentFile(file) && resolveDocumentViewUrl) openDocumentViewer(file, list)
    else if (kind === 'image') openImageLightbox(file, list)
    else if (kind === 'video') openVideoLightbox(file, list)
    else if (kind === 'audio') openAudioLightbox(file, list)
  }

  const openVersionContextMenu = (event: React.MouseEvent, file: DownloadableFile, list: DownloadableFile[]) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, file, imageList: list })
  }

  const statusPill = (tone: 'success' | 'warning' | 'info' | 'muted', Icon: typeof Check, text: string) => (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        tone === 'success' && 'bg-success/15 text-success',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'info' && 'bg-primary/15 text-primary',
        tone === 'muted' && 'bg-muted text-muted-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {text}
    </span>
  )

  const versionBadge = (tone: 'warning' | 'info' | 'muted', text: string) => (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-tight',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'info' && 'bg-primary/15 text-primary',
        tone === 'muted' && 'bg-muted text-muted-foreground'
      )}
    >
      {text}
    </span>
  )

  // Full-width stacked buttons in a narrow column, side by side once there's room.
  const bigActionClass = 'h-auto w-full justify-start gap-3 px-4 py-2.5 text-left @md:w-auto'
  const sectionHeader = (title: string, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 px-1">
      <h4 className="shrink-0 text-base font-bold text-foreground">{title}</h4>
      {hint ? <span className="text-right text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )

  const renderDeliveryAssetRow = (file: DownloadableFile, assets: DownloadableFile[]) => {
    const fileKey = getDownloadableFileKey(file)
    const openMode = getAssetOpenMode(file)
    const kind = getDownloadableFileKind(file)
    const hasPreview = (kind === 'image' || kind === 'video') && Boolean(getResolvedPreviewSrc(file) || fileHasTimelineHover(file))
    const assetMeta = joinMeta([
      getAssetKindLabel(file),
      getFileExtensionLabel(file.fileName),
      kind === 'video'
        ? formatResolutionLabel(file.width, file.height)
        : kind === 'image' && file.width && file.height ? `${file.width}×${file.height}` : null,
      kind === 'video' || kind === 'audio' ? formatDuration(file.durationSeconds) : null,
    ])
    const sizeLabel = formatFileSize(file.fileSizeBytes)
    return (
      <div
        key={fileKey}
        ref={(node) => registerFilePreviewCardRef(fileKey, node)}
        data-file-preview-key={fileKey}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 @lg:px-4"
        onContextMenu={(event) => openVersionContextMenu(event, file, assets)}
      >
        {/* Thumbnail and name stay together; only the actions wrap below them when the
            column is too narrow. The thumbnail and name open the asset (view / play). */}
        <div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3">
        <button
          type="button"
          className={cn(
            'relative h-11 w-16 shrink-0 overflow-hidden rounded-md border border-border @lg:w-20',
            hasPreview ? 'bg-black/85' : 'bg-muted',
            openMode ? 'cursor-pointer' : 'cursor-default'
          )}
          onClick={() => { if (openMode) openAsset(file, assets) }}
          tabIndex={openMode ? 0 : -1}
          aria-label={openMode ? `Open ${file.fileName}` : file.fileName}
        >
          {renderMediaThumb(file, { iconClassName: 'h-5 w-5' })}
        </button>
        <div className="min-w-0 flex-1">
          {openMode ? (
            <button
              type="button"
              className="block max-w-full text-left text-sm font-semibold text-foreground hover:underline"
              title={file.fileName}
              onClick={() => openAsset(file, assets)}
            >
              <span className="line-clamp-2 wrap-anywhere">{file.fileName}</span>
            </button>
          ) : (
            <p className="line-clamp-2 text-sm font-semibold text-foreground wrap-anywhere" title={file.fileName}>{file.fileName}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {assetMeta}
            {sizeLabel ? <span className="@lg:hidden"> · {sizeLabel}</span> : null}
          </p>
        </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
        {sizeLabel ? (
          <span className="hidden text-xs text-muted-foreground tabular-nums @lg:block">{sizeLabel}</span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => void onDownloadFile(file)}
          aria-label={`Download ${file.fileName}`}
        >
          <Download />
          <span className="hidden @lg:inline">Download</span>
        </Button>
        </div>
      </div>
    )
  }

  const renderVideoFolderView = () => {
    const versions = openFolderVideoVersions
    if (versions.length === 0) {
      return <p className="px-1 text-xs text-muted-foreground italic">No video versions available.</p>
    }

    const folderName = openFolder?.name || ''
    const approved = openFolderApprovedVideoVersion
    const latest = versions[0]
    const hero = approved || latest
    const heroExt = getFileExtensionLabel(hero.fileName)
    const heroResolution = formatResolutionLabel(hero.width, hero.height)
    const heroDuration = formatDuration(hero.durationSeconds)
    const heroSize = formatFileSize(hero.fileSizeBytes)
    const heroMeta = joinMeta([
      heroExt,
      formatCodecLabel(hero.codec),
      hero.width && hero.height ? `${hero.width}×${hero.height}` : null,
      heroDuration,
    ])
    const masterSpec = joinMeta([heroExt, heroResolution, heroSize])
    const canWatch = Boolean(onOpenVideoVersion && hero.videoId)

    // Signed-off project, but this video has no approved version: approval was off for it,
    // or changes were requested and the project was approved anyway. Either way it is view-only.
    const isViewOnly = !approved && projectApproved

    let pill: React.ReactNode
    if (approved) {
      pill = statusPill('success', Check, joinMeta(['Approved', formatShortDate(approved.approvedAt)]))
    } else if (isViewOnly) {
      pill = statusPill('muted', Eye, 'View only')
    } else if (latest.isRevisionRequested) {
      pill = statusPill('info', RotateCcw, joinMeta(['Changes requested', formatShortDate(latest.revisionRequestedAt)]))
    } else {
      pill = statusPill('warning', Clock, joinMeta(['For review', formatShortDate(latest.createdAt)]))
    }

    const heroApprovable = !approved && isVersionApprovable(hero)
    // Mirrors the comment panel's Request Next Version rules (and the API's): client only,
    // latest version, nothing approved, not already requested, at least one comment on it.
    const canRequestNext = Boolean(
      !isAdmin && onRequestNextVersion && !approved && !isViewOnly && hero === latest && latest.videoId && !latest.isRevisionRequested
    )
    const latestFeedbackCount = latest.feedbackCount ?? 0
    const canShare = Boolean(projectId && hero.videoId)
    const anyApprovable = !approved && versions.some(isVersionApprovable)
    let note: { icon: typeof Info; text: string } | null = null
    if (approved) {
      note = null
    } else if (isViewOnly) {
      note = latest.isRevisionRequested
        ? { icon: Info, text: 'The project has been approved. Changes were requested on this version, so it isn’t available to download.' }
        : { icon: Info, text: 'The project has been approved. This video was shared for viewing only, so there’s no download.' }
    } else if (anyApprovable) {
      note = {
        icon: Lock,
        text: `Download unlocks when you approve${heroApprovable ? '' : ' a version'}: the full-quality master${masterSpec ? ` (${masterSpec})` : ''} plus any extras the studio has added.`,
      }
    } else if (latest.isRevisionRequested) {
      note = { icon: Info, text: 'Changes have been requested. The next version will appear here once it is ready.' }
    } else {
      note = { icon: Lock, text: 'Downloads are not enabled for this video yet.' }
    }
    const NoteIcon = note?.icon ?? null

    const assets = openFolderVideoAssets
    const deliveryFiles = approved ? [approved, ...assets] : []
    const deliveryBytes = deliveryFiles.reduce((total, file) => total + getFileSizeBytes(file), 0)
    const deliveryIsZip = deliveryBytes > 0 && deliveryBytes <= ZIP_DOWNLOAD_THRESHOLD_BYTES

    return (
      <div className="space-y-6 px-1 pt-2">
        {/* Hero */}
        <div className="flex flex-col gap-4 @xl:flex-row @xl:items-start @xl:gap-6">
          <div
            role={canWatch ? 'button' : undefined}
            tabIndex={canWatch ? 0 : undefined}
            aria-label={canWatch ? `Watch ${folderName} ${hero.versionLabel || ''}`.trim() : undefined}
            className={cn(
              'relative aspect-video w-full shrink-0 overflow-hidden rounded-xl border border-border bg-black/85 shadow-sm @xl:w-60 @3xl:w-80',
              canWatch && 'cursor-pointer'
            )}
            onClick={() => watchVersion(hero)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                watchVersion(hero)
              }
            }}
            onContextMenu={(event) => openVersionContextMenu(event, hero, versions)}
          >
            {renderMediaThumb(hero, {
              posterFallback: folderPreviewByName?.[folderName] || null,
              showPlay: canWatch,
              versionBadge: true,
              iconClassName: 'h-10 w-10',
            })}
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              {pill}
              {canShare ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-8 shrink-0"
                  onClick={() => setShareVideoId(hero.videoId || null)}
                  title="Share a view-only link to this version"
                >
                  <Share2 className="h-4 w-4" />
                  Share
                </Button>
              ) : null}
            </div>
            <div className="space-y-1">
              <h3 className="text-xl font-semibold leading-tight text-foreground @2xl:text-2xl wrap-break-word">
                {folderName}
                {hero.versionLabel ? <span className="font-normal text-muted-foreground"> · {hero.versionLabel}</span> : null}
              </h3>
              {heroMeta ? <p className="text-sm text-muted-foreground">{heroMeta}</p> : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {approved ? (
                <>
                  <Button type="button" className={bigActionClass} onClick={() => void onDownloadFile(approved)}>
                    <Download className="h-5! w-5!" />
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold">Download video</span>
                      {masterSpec ? <span className="text-[11px] font-normal opacity-85">{masterSpec}</span> : null}
                    </span>
                  </Button>
                  {assets.length > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      className={bigActionClass}
                      disabled={isDownloadBusy}
                      onClick={() => void downloadFileSet(deliveryFiles)}
                    >
                      <FileArchive className="h-5! w-5!" />
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">
                          {isDownloadBusy
                            ? activeProgress ? `Downloading… ${Math.round(activeProgress.percent)}%` : 'Preparing…'
                            : deliveryIsZip ? 'Everything (ZIP)' : 'Everything'}
                        </span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {joinMeta([`${deliveryFiles.length} files`, deliveryBytes > 0 ? formatFileSize(deliveryBytes) : null])}
                        </span>
                      </span>
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  {canWatch ? (
                    <Button type="button" variant="outline" className={bigActionClass} onClick={() => watchVersion(hero)}>
                      <Play className="h-4! w-4! fill-current" />
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">Watch {hero.versionLabel || 'video'}</span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {joinMeta([heroDuration, isViewOnly ? 'add a comment' : latest.isRevisionRequested ? 'add more comments' : 'leave feedback'])}
                        </span>
                      </span>
                    </Button>
                  ) : null}
                  {heroApprovable ? (
                    <Button
                      type="button"
                      variant="success"
                      className={bigActionClass}
                      disabled={approving}
                      onClick={() => requestApproveVersion(hero)}
                    >
                      <Check className="h-5! w-5!" />
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">Approve {hero.versionLabel || 'video'}</span>
                        <span className="text-[11px] font-normal opacity-85">unlocks the download</span>
                      </span>
                    </Button>
                  ) : null}
                  {canRequestNext && latestFeedbackCount > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      className={bigActionClass}
                      disabled={requestingNext}
                      onClick={() => setRequestNextFile(latest)}
                    >
                      <RotateCcw className="h-5! w-5!" />
                      <span className="flex flex-col">
                        <span className="text-sm font-semibold">Request next version</span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {joinMeta([`${latestFeedbackCount} ${latestFeedbackCount === 1 ? 'comment' : 'comments'}`, 'locks in your feedback'])}
                        </span>
                      </span>
                    </Button>
                  ) : null}
                  {canRequestNext && latestFeedbackCount === 0 ? (
                    <span className="inline-flex items-center gap-1.5 self-center text-xs text-muted-foreground">
                      <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                      Leave feedback to request changes
                    </span>
                  ) : null}
                </>
              )}
            </div>

            {note && NoteIcon ? (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <NoteIcon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{note.text}</span>
              </p>
            ) : null}
          </div>
        </div>

        {approved ? (
          <>
            {assets.length > 0 ? (
              <section className="space-y-2">
                {sectionHeader('Also included')}
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {assets.map((file) => renderDeliveryAssetRow(file, assets))}
                </div>
              </section>
            ) : null}

            {versions.length > 1 ? (
              <section className="space-y-2">
                {sectionHeader('Other versions', 'Not part of the delivery')}
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {versions.filter((file) => file !== approved).map((file) => {
                    const fileKey = getDownloadableFileKey(file)
                    const reason = file.isRevisionRequested
                      ? 'Changes requested, then replaced'
                      : `Not available, ${approved.versionLabel || 'another version'} was approved`
                    return (
                      <div
                        key={fileKey}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 @lg:px-4"
                        onContextMenu={(event) => openVersionContextMenu(event, file, versions)}
                      >
                        <div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3">
                        <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-black/85 opacity-60 grayscale @lg:h-14 @lg:w-24">
                          {renderMediaThumb(file, { scrub: false, iconClassName: 'h-5 w-5' })}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">
                            <span className="font-semibold text-foreground">{folderName}{file.versionLabel ? ` · ${file.versionLabel}` : ''}</span>
                            {formatShortDate(file.createdAt) ? <span className="text-muted-foreground"> · {formatShortDate(file.createdAt)}</span> : null}
                          </p>
                          <p className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground @lg:text-sm">
                            <Lock className="mt-px h-3.5 w-3.5 shrink-0 @lg:mt-0.5" />
                            <span>{reason}</span>
                          </p>
                        </div>
                        </div>
                        {isAdmin ? (
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            <Button type="button" variant="outline" size="xs" onClick={() => void onDownloadFile(file)} aria-label={`Download ${file.versionLabel || file.fileName}`} title="Download (admin)">
                              <Download />
                            </Button>
                            {onOpenVideoVersion ? (
                              <Button type="button" variant="outline" size="xs" onClick={() => watchVersion(file)}>
                                <Play className="fill-current" />
                                <span className="hidden @lg:inline">Watch</span>
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}
          </>
        ) : (
          <section className="space-y-2">
            {sectionHeader('Versions', versions.length > 1 ? 'Newest first' : undefined)}
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {versions.map((file) => {
                const fileKey = getDownloadableFileKey(file)
                const isLatest = getDownloadableFileKey(file) === getDownloadableFileKey(latest)
                const badge = isLatest
                  ? isViewOnly
                    ? versionBadge('muted', 'Latest · view only')
                    : file.isRevisionRequested
                    ? versionBadge('info', 'Latest · changes requested')
                    : versionBadge('warning', 'Latest · for review')
                  : file.isRevisionRequested
                    ? versionBadge('info', 'Changes requested')
                    : versionBadge('muted', 'Earlier cut')
                const description = file.notes || joinMeta([formatDuration(file.durationSeconds), formatResolutionLabel(file.width, file.height)])
                const canWatchVersion = Boolean(onOpenVideoVersion && file.videoId)
                // Every approvable row gets its own Approve, including the latest one the
                // hero also offers, so the Versions list reads consistently.
                const showRowApprove = isVersionApprovable(file)
                return (
                  <div
                    key={fileKey}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 @lg:px-4"
                    onContextMenu={(event) => openVersionContextMenu(event, file, versions)}
                  >
                    {/* Thumbnail and details stay together; only the buttons wrap below
                        them when the column is too narrow. */}
                    <div className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3">
                    <div
                      className={cn(
                        'relative h-12 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-black/85 @lg:h-14 @lg:w-24',
                        canWatchVersion && 'cursor-pointer'
                      )}
                      onClick={() => watchVersion(file)}
                    >
                      {renderMediaThumb(file, {
                        posterFallback: isLatest ? folderPreviewByName?.[folderName] || null : null,
                        iconClassName: 'h-5 w-5',
                      })}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-semibold text-foreground">{file.versionLabel || 'Version'}</span>
                        {formatShortDate(file.createdAt) ? (
                          <span className="text-sm text-muted-foreground">· {formatShortDate(file.createdAt)}</span>
                        ) : null}
                        {badge}
                      </div>
                      {description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground @lg:text-sm" title={file.notes || undefined}>{description}</p>
                      ) : null}
                    </div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {showRowApprove ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="border-success/50 text-success hover:border-success hover:bg-success/10 hover:text-success"
                          disabled={approving}
                          onClick={() => requestApproveVersion(file)}
                          aria-label={`Approve ${file.versionLabel || 'this version'}`}
                        >
                          <Check />
                          <span className="hidden @lg:inline">Approve</span>
                        </Button>
                      ) : null}
                      {isAdmin ? (
                        <Button type="button" variant="outline" size="xs" onClick={() => void onDownloadFile(file)} aria-label={`Download ${file.versionLabel || file.fileName}`} title="Download (admin)">
                          <Download />
                        </Button>
                      ) : null}
                      {canWatchVersion ? (
                        <Button type="button" variant="outline" size="xs" onClick={() => watchVersion(file)} aria-label={`Watch ${file.versionLabel || 'version'}`}>
                          <Play className="fill-current" />
                          <span className="hidden @lg:inline">Watch</span>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>
    )
  }

  const renderAlbumFolderView = () => {
    const albumName = openFolder?.name || ''
    const photos = openFolderAlbumPhotos
    const zips = openFolderAlbumZips
    const fullZip = zips.find((file) => file.variant === 'full') ?? null
    const socialZip = zips.find((file) => file.variant === 'social') ?? null
    const photoCountLabel = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`
    const photoBytes = photos.reduce((total, file) => total + getFileSizeBytes(file), 0)
    const albumMeta = joinMeta([photoCountLabel, photoBytes > 0 ? `${formatFileSize(photoBytes)} in total` : null])
    const albumNotes = String(openFolder?.notes || '').trim()
    const coverPhotos = photos.slice(0, 3)
    const extraPhotoCount = Math.max(0, photos.length - coverPhotos.length)
    const albumId = [...zips, ...photos].map((file) => file.albumId).find((id): id is string => typeof id === 'string' && id.length > 0) ?? null
    // The guest-link API needs an admin session or a share JWT; without one, Generate would only 401.
    const canShareAlbum = Boolean(albumId && (isAdmin || shareToken))

    const renderCoverCell = (file: DownloadableFile, index: number, className: string) => {
      const src = getResolvedPreviewSrc(file)
      const showMore = index === coverPhotos.length - 1 && extraPhotoCount > 0
      return (
        <button
          key={getDownloadableFileKey(file)}
          type="button"
          className={cn('relative min-h-0 overflow-hidden bg-black/60', className)}
          onClick={() => openImageLightbox(file, photos)}
          aria-label={`View ${file.fileName}`}
        >
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <FileImage className="mx-auto h-6 w-6 text-muted-foreground" />
          )}
          {showMore ? (
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm font-semibold text-white">
              +{extraPhotoCount}
            </span>
          ) : null}
        </button>
      )
    }

    return (
      <div className="space-y-6 px-1 pt-2">
        {/* Header */}
        <div className="flex flex-col gap-4 @xl:flex-row @xl:items-start @xl:gap-6">
          <div
            className={cn(
              'grid aspect-4/3 w-full shrink-0 gap-0.5 overflow-hidden rounded-xl border border-border bg-black/85 shadow-sm @xl:w-60 @3xl:w-80',
              coverPhotos.length >= 3 ? 'grid-cols-3 grid-rows-2' : coverPhotos.length === 2 ? 'grid-cols-2' : 'grid-cols-1'
            )}
          >
            {coverPhotos.length === 0 ? (
              <div className="flex items-center justify-center">
                <FileImage className="h-10 w-10 text-muted-foreground" />
              </div>
            ) : (
              coverPhotos.map((file, index) =>
                renderCoverCell(file, index, coverPhotos.length >= 3 && index === 0 ? 'col-span-2 row-span-2' : '')
              )
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex items-center gap-2">
              {statusPill('info', FileImage, joinMeta([photoCountLabel, formatShortDate(openFolder?.createdAt)]))}
              {canShareAlbum ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-8 shrink-0"
                  onClick={() => setShareAlbumId(albumId)}
                  title="Share a guest link to this album"
                >
                  <Share2 className="h-4 w-4" />
                  Share
                </Button>
              ) : null}
            </div>
            <div className="space-y-1">
              <h3 className="text-xl font-semibold leading-tight text-foreground @2xl:text-2xl wrap-break-word">{albumName}</h3>
              {albumMeta ? <p className="text-sm text-muted-foreground">{albumMeta}</p> : null}
            </div>

            {fullZip || socialZip ? (
              <div className="flex flex-wrap gap-2">
                {fullZip ? (
                  <Button type="button" className={bigActionClass} onClick={() => void onDownloadFile(fullZip)}>
                    <Download className="h-5! w-5!" />
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold">Full resolution</span>
                      <span className="text-[11px] font-normal opacity-85">
                        {joinMeta(['ZIP', photoCountLabel, formatFileSize(fullZip.fileSizeBytes)])}
                      </span>
                    </span>
                  </Button>
                ) : null}
                {socialZip ? (
                  <Button
                    type="button"
                    variant={fullZip ? 'outline' : 'default'}
                    className={bigActionClass}
                    onClick={() => void onDownloadFile(socialZip)}
                  >
                    <FileArchive className="h-5! w-5!" />
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold">Social sized</span>
                      <span className={cn('text-[11px] font-normal', fullZip ? 'text-muted-foreground' : 'opacity-85')}>
                        {joinMeta(['ZIP', '2048 px long edge', formatFileSize(socialZip.fileSizeBytes)])}
                      </span>
                    </span>
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>The album ZIPs are still being prepared. You can download photos one at a time below.</span>
              </p>
            )}

            {albumNotes ? (
              <p className="whitespace-pre-line text-sm text-muted-foreground wrap-break-word">{albumNotes}</p>
            ) : null}
          </div>
        </div>

        {/* Photos */}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1">
            <h4 className="text-base font-bold text-foreground">Photos</h4>
            <span className="text-xs text-muted-foreground">Tick several to get one ZIP · click to view</span>
            <div className="ml-auto">
          <div className="ml-auto inline-flex items-center rounded-md border border-border overflow-hidden">
            <button
              type="button"
              className={cn(
                'px-2 py-1 text-[11px] font-semibold transition-colors',
                albumPhotosThumbnailSize === 'small'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setAlbumPhotosThumbnailSize('small')}
            >
              Small
            </button>
            <button
              type="button"
              className={cn(
                'px-2 py-1 text-[11px] font-semibold transition-colors border-l border-border',
                albumPhotosThumbnailSize === 'default'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setAlbumPhotosThumbnailSize('default')}
            >
              Default
            </button>
            <button
              type="button"
              className={cn(
                'px-2 py-1 text-[11px] font-semibold transition-colors border-l border-border',
                albumPhotosThumbnailSize === 'large'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setAlbumPhotosThumbnailSize('large')}
            >
              Large
            </button>
          </div>
            </div>
          </div>
          {photos.length > 0 ? (
            <div className={cn(
              'grid',
              albumPhotosThumbnailSize === 'large'
                ? 'grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4 gap-3'
                : albumPhotosThumbnailSize === 'default'
                  ? 'grid-cols-2 @xl:grid-cols-3 @3xl:grid-cols-4 @6xl:grid-cols-5 gap-3'
                  : 'grid-cols-2 @md:grid-cols-4 @3xl:grid-cols-6 @6xl:grid-cols-8 gap-2.5'
            )}>
              {photos.map((file) => renderOpenFolderFileCard(file, albumPhotosThumbnailSize === 'small', photos))}
            </div>
          ) : (
            <p className="px-1 text-xs text-muted-foreground italic">No photos available.</p>
          )}
        </section>
      </div>
    )
  }

  const rootSectionToneClass = {
    warning: 'bg-warning/15 text-warning ring-warning/30',
    info: 'bg-primary/15 text-primary ring-primary/30',
    success: 'bg-success/15 text-success ring-success/30',
    violet: 'bg-violet-500/15 text-violet-400 ring-violet-500/30',
    sky: 'bg-sky-500/15 text-sky-400 ring-sky-500/30',
    muted: 'bg-muted-foreground/15 text-muted-foreground ring-muted-foreground/30',
  } as const
  const rootSectionBandClass: Record<keyof typeof rootSectionToneClass, string> = {
    warning: 'bg-warning/12 border-l-warning',
    info: 'bg-primary/12 border-l-primary',
    success: 'bg-success/12 border-l-success',
    violet: 'bg-violet-500/12 border-l-violet-500',
    sky: 'bg-sky-500/12 border-l-sky-500',
    muted: 'bg-muted-foreground/10 border-l-muted-foreground/60',
  }

  // Root-level section (For Review / Reviewed / Approved / Albums / Additional Files):
  // a full-width band with a flat tint in the same colour as the folder badges (accent edge
  // on the left) holding an icon tile, the title with a count, and a one-line description.
  // The sidebar's section labels (VideoSidebar SidebarSectionBanner) are the compact twin.
  const renderRootSection = (
    tone: keyof typeof rootSectionToneClass,
    Icon: typeof Check,
    title: string,
    description: string,
    groups: DownloadableGroup[],
  ) => (
    <section key={title} className="space-y-3">
      <div className={cn('flex items-center gap-3 rounded-r-lg border-l-[3px] py-2.5 pl-3 pr-3', rootSectionBandClass[tone])}>
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset', rootSectionToneClass[tone])}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-base font-bold leading-tight text-foreground @lg:text-lg">{title}</h4>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold leading-none text-muted-foreground tabular-nums">
              {groups.length}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @xl:grid-cols-3 @3xl:grid-cols-4 @6xl:grid-cols-5">
        {groups.map((group) => renderRootFolderCard(group))}
      </div>
    </section>
  )

  const renderRootFolderCard = (group: DownloadableGroup) => {
    const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
    const groupSelectableFiles = getGroupSelectableFiles(group, isAdmin)
    const hasSelectableFiles = groupSelectableFiles.length > 0
    const uploadFolderPath = group.groupType === 'uploads' ? getUploadsFolderPathFromGroup(group.name) : ''
    const displayGroupName = group.groupType === 'uploads'
      ? getUploadsFolderLabelFromGroup(group.name)
      : group.name
    const groupVideoFiles = groupFiles.filter((file) => file.type === 'video')
    const groupHasApprovedVideo = groupVideoFiles.some((file) => file.isApproved === true)
    const groupIsReviewed = isVideoGroupReviewed(group)
    const showVideoFolderApprovedBadge = group.groupType === 'video' && groupHasApprovedVideo
    const showVideoFolderViewOnlyBadge = group.groupType === 'video' && !groupHasApprovedVideo && projectApproved
    const showVideoFolderReviewedBadge = group.groupType === 'video' && !groupHasApprovedVideo && !projectApproved && groupIsReviewed
    const showVideoFolderForReviewBadge = group.groupType === 'video' && !groupHasApprovedVideo && !projectApproved && !groupIsReviewed
    const groupFileKeys = groupSelectableFiles.map(getDownloadableFileKey)
    const allChecked = groupFileKeys.length > 0 && groupFileKeys.every((key) => selectedFileIds.has(key))
    const someChecked = groupFileKeys.some((key) => selectedFileIds.has(key))
    const folderPreview = folderPreviewByName?.[group.name] || null
    const folderPreviewTiles = folderPreviewTilesByName[group.name] || []
    const folderVideoPreviewUrl = folderPreviewPosterByName[group.name] || null

    return (
      <div
        key={group.name}
        ref={(node) => registerFolderPreviewCardRef(group.name, node)}
        data-folder-preview-key={group.name}
        className={cn(
          'rounded-xl bg-card transition-colors overflow-hidden shadow-sm',
          someChecked
            ? 'border-2 border-primary/85 hover:border-primary'
            : 'border border-border hover:border-primary/45'
        )}
        onClick={() => navigateToFolder(group.name)}
        onDragOver={(event) => {
          if (group.groupType !== 'uploads') return
          if (!allowUploadDrop(event)) return
          event.stopPropagation()
        }}
        onDrop={(event) => {
          if (group.groupType !== 'uploads') return
          if (!allowUploadDrop(event)) return
          event.stopPropagation()
          const targetPath = getUploadsFolderPathFromGroup(group.name)
          const droppedFiles = Array.from(event.dataTransfer?.files || [])
          void submitUploadFiles(targetPath, droppedFiles)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setContextMenu({ x: event.clientX, y: event.clientY, group })
        }}
      >
        <div className="relative p-2.5 pb-2 bg-linear-to-b from-muted/80 via-muted/45 to-background">
          <FolderPreviewMosaic
            label={group.name}
            tiles={folderPreviewTiles}
            fallbackPreview={folderPreview}
            videoPoster={folderVideoPreviewUrl}
            isUploads={group.groupType === 'uploads'}
            onTileError={() => {
              invalidateFolderPreviewTiles(group.name)
              requestPreviewTokenRefresh()
            }}
          />

          {showVideoFolderApprovedBadge ? (
            <div className="absolute bottom-2 left-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[11px] leading-none text-white font-semibold tracking-wide">
              APPROVED
            </div>
          ) : null}

          {showVideoFolderViewOnlyBadge ? (
            <div className="absolute bottom-2 left-2 rounded bg-muted px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground font-semibold tracking-wide ring-1 ring-inset ring-border" title="Shared for viewing only">
              VIEW ONLY
            </div>
          ) : null}

          {showVideoFolderReviewedBadge ? (
            <div className="absolute bottom-2 left-2 rounded bg-primary px-1.5 py-0.5 text-[11px] leading-none text-primary-foreground font-semibold tracking-wide" title="Next version requested">
              REVIEWED
            </div>
          ) : null}

          {showVideoFolderForReviewBadge ? (
            <div className="absolute bottom-2 left-2 rounded bg-amber-500/95 px-1.5 py-0.5 text-[11px] leading-none text-black font-semibold tracking-wide">
              FOR REVIEW
            </div>
          ) : null}

          <div className="absolute top-2 left-2">
            <input
              type="checkbox"
              checked={allChecked}
              disabled={!hasSelectableFiles}
              ref={(el) => {
                if (el) el.indeterminate = someChecked && !allChecked
              }}
              onChange={(event) => toggleGroup(group, event.target.checked)}
              onClick={(event) => event.stopPropagation()}
              className={cn('w-4 h-4', FILES_CHECKBOX_CLASS, hasSelectableFiles ? 'cursor-pointer' : 'cursor-not-allowed opacity-40')}
              aria-label={`Select files in ${displayGroupName}`}
            />
          </div>
        </div>

        {/* Not a <button>: this region contains the folder-actions dropdown trigger
            (itself a <button>), and a button-in-button is invalid HTML — the browser
            hoists the inner one out, desyncing React's tree from the DOM. The outer
            card <div> already handles open-on-click, so a plain <div> is enough. */}
        <div className="w-full text-left px-3 py-2.5">
          <div className="flex items-start justify-between gap-2 min-w-0">
            <div className="flex items-start gap-2 min-w-0">
              <Folder className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <span
                className="text-sm font-semibold text-foreground line-clamp-2 wrap-break-word min-h-[2.5rem]"
                title={displayGroupName}
              >
                {displayGroupName}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {group.groupType === 'uploads' && canDeleteUploads && uploadFolderPath ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-6 w-6"
                      disabled={isUploadActionBusy}
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      title="Folder actions"
                      aria-label="Folder actions"
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                    {onRenameUploadFolder ? (
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault()
                          void renameUploadFolder(uploadFolderPath, displayGroupName.split('/').pop()?.trim() || displayGroupName)
                        }}
                      >
                        <Pencil className="mr-2 h-3.5 w-3.5" />
                        Rename folder
                      </DropdownMenuItem>
                    ) : null}
                    {onDeleteUploadFolder ? (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={(event) => {
                          event.preventDefault()
                          void deleteUploadFolder(uploadFolderPath)
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete folder
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <MoreHorizontal className="w-4 h-4 text-muted-foreground shrink-0" />
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            {groupFiles.length} Item{groupFiles.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="@container border border-border rounded-lg bg-card overflow-hidden flex-1 min-h-0 flex flex-col">
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || [])
          void submitUploadFiles(pendingUploadFolderPath, files)
          event.currentTarget.value = ''
        }}
      />
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2">
        <div className="min-w-0 flex items-center justify-between gap-2 @xl:flex-1">
          <div className="min-w-0">
            {openFolder ? (
              <div className="flex items-center gap-2 min-w-0">
                <Button type="button" variant="outline" size="sm" className="px-2 @xl:px-3" onClick={navigateBackFolder}>
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden @xl:inline">Back</span>
                </Button>
                {selectedCount > 0 && !isVideoFolderView ? (
                  <span className="hidden @xl:inline text-xs @2xl:text-sm text-muted-foreground truncate">
                    {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                  </span>
                ) : null}
              </div>
            ) : (
              selectedCount > 0 ? (
                <span className="hidden @xl:inline text-xs @2xl:text-sm text-muted-foreground truncate">
                  {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                </span>
              ) : (
                <span className="sr-only">Root folder</span>
              )
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 @xl:hidden">
            {isUploadsContext && canUploadToProjects && onUploadFiles ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 gap-1"
                onClick={openUploadFilePicker}
                disabled={isUploadActionBusy}
                aria-label="Add files"
                title="Add files"
              >
                <Plus className="w-4 h-4" />
                <File className="w-4 h-4" />
              </Button>
            ) : null}
            {isUploadsContext && canUploadToProjects && onCreateUploadFolder ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 gap-1"
                onClick={runCreateUploadFolder}
                disabled={isUploadActionBusy}
                aria-label="Add folder"
                title="Add folder"
              >
                <Plus className="w-4 h-4" />
                <Folder className="w-4 h-4" />
              </Button>
            ) : null}
            {!isVideoFolderView ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                'h-8 px-2',
                allVisibleSelected && 'bg-primary/12 text-primary border-primary/40 hover:bg-primary/18'
              )}
              disabled={visibleFiles.length === 0}
              onClick={toggleAllVisibleSelection}
              aria-label={allVisibleSelected ? 'Unselect all' : 'Select all'}
              title={allVisibleSelected ? 'Unselect all' : 'Select all'}
            >
              {allVisibleSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <Files className="w-4 h-4" />
            </Button>
            ) : null}
            {openFolder?.groupType === 'uploads' && canDeleteUploads && onDeleteUploadFile ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => void deleteSelectedUploadFiles()}
                disabled={isUploadActionBusy || selectedUploadFilesInContext.length === 0}
                aria-label={`Delete ${selectedUploadFilesInContext.length} selected upload files`}
                title={`Delete ${selectedUploadFilesInContext.length} selected upload files`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            ) : null}
            {!isVideoFolderView ? (
            <Button
              type="button"
              size="sm"
              className="h-8 px-2"
              onClick={downloadSelected}
              disabled={selectedCount === 0 || isDownloadBusy}
              aria-label={`Download ${selectedCount} selected files`}
              title={`Download ${selectedCount} selected files`}
            >
              <Download className="w-4 h-4" />
              <span className="text-xs font-semibold tabular-nums">{selectedCount}</span>
            </Button>
            ) : null}
          </div>
          <div className="hidden @xl:flex items-center gap-2 ml-auto">
            {isUploadsContext && canUploadToProjects && onUploadFiles ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-0 justify-center gap-1.5"
                onClick={openUploadFilePicker}
                disabled={isUploadActionBusy}
                aria-label="Add files"
                title="Add files"
              >
                <Plus className="w-4 h-4" />
                <File className="w-4 h-4" />
                <span className="sr-only">File</span>
              </Button>
            ) : null}
            {isUploadsContext && canUploadToProjects && onCreateUploadFolder ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-w-0 justify-center gap-1.5"
                onClick={runCreateUploadFolder}
                disabled={isUploadActionBusy}
                aria-label="Add folder"
                title="Add folder"
              >
                <Plus className="w-4 h-4" />
                <Folder className="w-4 h-4" />
                <span className="sr-only">Folder</span>
              </Button>
            ) : null}
            {!isVideoFolderView ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                'min-w-0 justify-center gap-1.5',
                allVisibleSelected && 'bg-primary/12 text-primary border-primary/40 hover:bg-primary/18'
              )}
              disabled={visibleFiles.length === 0}
              onClick={toggleAllVisibleSelection}
              aria-label={allVisibleSelected ? 'Unselect all' : 'Select all'}
              title={allVisibleSelected ? 'Unselect all' : 'Select all'}
            >
              {allVisibleSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <Files className="w-4 h-4" />
            </Button>
            ) : null}
            {openFolder?.groupType === 'uploads' && canDeleteUploads && onDeleteUploadFile ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-w-0"
                onClick={() => void deleteSelectedUploadFiles()}
                disabled={isUploadActionBusy || selectedUploadFilesInContext.length === 0}
              >
                <Trash2 className="w-4 h-4 mr-1.5" />
                <span>Delete ({selectedUploadFilesInContext.length})</span>
              </Button>
            ) : null}
            {!isVideoFolderView ? (
            <Button
              type="button"
              size="sm"
              className="min-w-0"
              onClick={downloadSelected}
              disabled={selectedCount === 0 || isDownloadBusy}
            >
              <Download className="w-4 h-4" />
              {isDownloadBusy
                ? activeProgress
                  ? `Downloading… ${Math.round(activeProgress.percent)}%`
                  : 'Preparing…'
                : `Download (${selectedCount})`}
            </Button>
            ) : null}
            {onCloseFilesView ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-w-0 justify-center"
                onClick={onCloseFilesView}
                aria-label="Close files view"
                title="Close files view"
              >
                <X className="w-4 h-4" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div
        ref={scrollAreaRef}
        className="flex-1 min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-4 bg-muted/70"
        onDragOverCapture={(event) => {
          if (!isUploadsContext) return
          void allowUploadDrop(event)
        }}
        onDragOver={(event) => {
          if (!isUploadsContext) return
          void allowUploadDrop(event)
        }}
        onDrop={(event) => {
          if (!isUploadsContext) return
          if (!allowUploadDrop(event)) return
          const droppedFiles = Array.from(event.dataTransfer?.files || [])
          void submitUploadFiles(uploadsTargetFolderPath, droppedFiles)
        }}
      >
        {!openFolder ? (
          <div className="space-y-8 pt-1">
            {rootVideoGroupsForReview.length > 0
              ? renderRootSection('warning', Play, 'For Review', 'Videos waiting for your feedback or approval', rootVideoGroupsForReview)
              : null}
            {rootVideoGroupsReviewed.length > 0
              ? renderRootSection('info', RotateCcw, 'Reviewed', 'Changes requested · the next version is on its way', rootVideoGroupsReviewed)
              : null}
            {rootVideoGroupsApproved.length > 0
              ? renderRootSection('success', CheckCircle2, 'Approved', 'Signed off and ready to download', rootVideoGroupsApproved)
              : null}
            {rootVideoGroupsViewOnly.length > 0
              ? renderRootSection('muted', Eye, 'View Only', 'Shared for viewing · no download', rootVideoGroupsViewOnly)
              : null}
            {rootAlbumGroups.length > 0
              ? renderRootSection('violet', Images, 'Albums', 'Photo albums to view and download', rootAlbumGroups)
              : null}
            {rootUploadsSectionGroups.length > 0
              ? renderRootSection('sky', Files, 'Additional Files', 'Other files and folders shared on this project', rootUploadsSectionGroups)
              : null}
          </div>
        ) : (
          <div className="space-y-5">
            {openFolder?.groupType === 'video' ? (
              renderVideoFolderView()
            ) : openFolder?.groupType === 'album' ? (
              renderAlbumFolderView()
            ) : (
              <section className="space-y-2">
                <div className="px-1 flex items-center gap-2">
                  <h4 className="text-base sm:text-lg font-bold tracking-wider text-white">Additional Files</h4>
                  <div className="ml-auto inline-flex items-center rounded-md border border-border overflow-hidden">
                    <button
                      type="button"
                      className={cn(
                        'px-2 py-1 text-[11px] font-semibold transition-colors',
                        uploadsThumbnailSize === 'small'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setUploadsThumbnailSize('small')}
                    >
                      Small
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'px-2 py-1 text-[11px] font-semibold transition-colors border-l border-border',
                        uploadsThumbnailSize === 'default'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setUploadsThumbnailSize('default')}
                    >
                      Default
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'px-2 py-1 text-[11px] font-semibold transition-colors border-l border-border',
                        uploadsThumbnailSize === 'large'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => setUploadsThumbnailSize('large')}
                    >
                      Large
                    </button>
                  </div>
                </div>
                {/* Unified file-browser grid: child folders and files share one grid,
                    both sized by the Small/Default/Large toggle. Folders sort first. */}
                {(childUploadFolders.length > 0 || openFolderUploadFiles.length > 0) ? (
                  <div className={cn(
                    'grid',
                    uploadsThumbnailSize === 'large'
                      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3'
                      : uploadsThumbnailSize === 'default'
                        ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-3'
                        : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5'
                  )}>
                    {childUploadFolders.map((group) => renderRootFolderCard(group))}
                    {openFolderUploadFiles.map((file) => renderOpenFolderFileCard(file, uploadsThumbnailSize === 'small', openFolderUploadFiles))}
                  </div>
                ) : (
                  <p className="px-1 text-xs text-muted-foreground italic">This folder is empty.</p>
                )}
              </section>
            )}
          </div>
        )}

        {projectRootGroups.length === 0 && rootUploadsSectionGroups.length === 0 && !openFolder && (
          <div className={cn('h-full min-h-[180px] flex items-center justify-center text-sm text-muted-foreground')}>
            No files available.
          </div>
        )}
      </div>

      {(() => {
        const lightboxFile = lightboxState ? lightboxState.images[lightboxState.currentIndex] : null
        const lightboxFileKey = lightboxFile ? getDownloadableFileKey(lightboxFile) : null
        const lightboxPlaybackState = lightboxFile && lightboxFile.type === 'asset' && getDownloadableFileKind(lightboxFile) === 'video'
          ? videoPlaybackUrlByFileKey[lightboxFileKey!]
          : undefined
        const lightboxSrc = lightboxFile ? getLightboxUrl(lightboxFile) : null
        const isVideoLightbox = lightboxFile ? getDownloadableFileKind(lightboxFile) === 'video' : false
        const hasMultiple = lightboxState && lightboxState.images.length > 1
        return (
          <Dialog open={Boolean(lightboxState)} onOpenChange={(open) => { if (!open) setLightboxState(null) }}>
            <DialogContent
              className="max-w-[92vw] sm:max-w-5xl p-0 overflow-hidden bg-black border-border"
              title="File preview"
            >
              {lightboxFile ? (
                <div
                  className="relative w-full h-[70vh] bg-black"
                  onContextMenu={(e) => { e.preventDefault() }}
                >
                  {isVideoLightbox && lightboxSrc ? (
                    <HlsVideo
                      key={lightboxSrc}
                      url={lightboxSrc}
                      className="w-full h-full object-contain"
                      controls
                      autoPlay
                      playsInline
                      controlsList="nodownload noplaybackrate noremoteplayback"
                      disablePictureInPicture
                      onContextMenu={(e) => e.preventDefault()}
                    />
                  ) : isVideoLightbox && lightboxPlaybackState === undefined ? (
                    <div className="flex h-full w-full items-center justify-center text-sm text-white/75">
                      Loading video preview...
                    </div>
                  ) : isVideoLightbox ? (
                    <div className="flex h-full w-full items-center justify-center text-sm text-white/75">
                      Video preview is not available yet.
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={lightboxSrc || undefined}
                      alt={lightboxFile.fileName}
                      className="w-full h-full object-contain"
                    />
                  )}
                  <div className="absolute top-2 left-2 right-2 pointer-events-none">
                    <p
                      className="mx-auto max-w-[95%] rounded bg-black/70 px-2 py-1 text-center text-xs text-white truncate"
                      title={lightboxFile.fileName}
                    >
                      {lightboxFile.fileName}
                    </p>
                  </div>
                  {hasMultiple ? (
                    <>
                      <button
                        type="button"
                        onClick={() => navigateMixedLightbox(-1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Previous item"
                      >
                        <ChevronLeft className="w-6 h-6" />
                      </button>
                      <button
                        type="button"
                        onClick={() => navigateMixedLightbox(1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Next item"
                      >
                        <ChevronRight className="w-6 h-6" />
                      </button>
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] text-white tabular-nums">
                        {lightboxState!.currentIndex + 1} / {lightboxState!.images.length}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        )
      })()}

      {(() => {
        const audioFile = audioLightboxState ? audioLightboxState.files[audioLightboxState.currentIndex] : null
        const audioFileKey = audioFile ? getDownloadableFileKey(audioFile) : null
        const audioSrc = audioFileKey ? audioPlaybackUrlByFileKey[audioFileKey] : null
        const isLoadingAudio = Boolean(audioFileKey && audioPlaybackUrlByFileKey[audioFileKey] === undefined)
        const hasMultiple = audioLightboxState && audioLightboxState.files.length > 1

        return (
          <Dialog open={Boolean(audioLightboxState)} onOpenChange={(open) => { if (!open) setAudioLightboxState(null) }}>
            <DialogContent className="max-w-[92vw] sm:max-w-3xl p-0 overflow-hidden bg-black border-border" title="Audio player">
              {audioFile ? (
                <div className="relative w-full min-h-[260px] bg-black text-white p-5 sm:p-7 flex flex-col gap-5">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileAudio className="w-5 h-5 shrink-0 text-white/75" />
                    <p className="text-sm sm:text-base font-medium truncate" title={audioFile.fileName}>{audioFile.fileName}</p>
                  </div>

                  {audioSrc ? (
                    <audio
                      key={audioSrc}
                      src={audioSrc}
                      className="w-full"
                      controls
                      autoPlay
                      preload="metadata"
                    />
                  ) : isLoadingAudio ? (
                    <p className="text-sm text-white/75">Loading audio preview...</p>
                  ) : (
                    <p className="text-sm text-white/75">Audio playback is not available for this file yet.</p>
                  )}

                  {hasMultiple ? (
                    <>
                      <button
                        type="button"
                        onClick={() => navigateMixedLightbox(-1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Previous item"
                      >
                        <ChevronLeft className="w-6 h-6" />
                      </button>
                      <button
                        type="button"
                        onClick={() => navigateMixedLightbox(1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Next item"
                      >
                        <ChevronRight className="w-6 h-6" />
                      </button>
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] text-white tabular-nums">
                        {audioLightboxState!.currentIndex + 1} / {audioLightboxState!.files.length}
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        )
      })()}

      {(() => {
        const viewerFile = albumViewerState ? albumViewerState.images[albumViewerState.currentIndex] : null
        const viewerSrc = viewerFile ? getLightboxUrl(viewerFile) : null
        const hasMultiple = albumViewerState && albumViewerState.images.length > 1
        const socialEnabled = viewerFile?.albumId ? albumSocialEnabledByAlbumId[viewerFile.albumId] !== false : false
        const photoMeta = viewerFile?.photoId ? albumPhotoMetaByPhotoId[viewerFile.photoId] : null
        const canDownloadSocial = Boolean(socialEnabled && photoMeta?.socialDownloadUrl && photoMeta?.socialReady)

        return (
          <Dialog open={Boolean(albumViewerState)} onOpenChange={(open) => { if (!open) setAlbumViewerState(null) }}>
            <DialogContent className="max-w-none w-[95vw] h-[95vh] flex flex-col" title="Album photo viewer">
              {viewerFile && viewerSrc ? (
                <div className="flex-1 min-h-0 flex flex-col gap-3">
                  {/* pr-9 keeps the header clear of the dialog's absolutely positioned close button */}
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:pr-9">
                    <div className="min-w-0 pr-9 sm:pr-0">
                      <p className="text-sm text-muted-foreground">
                        This is a low resolution preview. Use the buttons to download the original versions.
                      </p>
                      <p className="mt-1 text-sm font-medium truncate" title={viewerFile.fileName}>{viewerFile.fileName}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 w-full sm:w-auto sm:flex sm:items-center sm:gap-2 sm:shrink-0">
                      {socialEnabled ? (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!canDownloadSocial}
                          onClick={() => {
                            if (!photoMeta?.socialDownloadUrl) return
                            triggerDirectDownload(photoMeta.socialDownloadUrl)
                          }}
                          className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Download Social Media Sized
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="default"
                        onClick={() => void onDownloadFile(viewerFile)}
                        className="w-full sm:w-auto whitespace-normal sm:whitespace-nowrap h-auto sm:h-10"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download Full Resolution
                      </Button>
                    </div>
                  </div>

                  <div className="rounded-lg overflow-hidden border bg-muted/20">
                    <div className="relative w-full h-[80dvh] group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={viewerSrc}
                        alt={viewerFile.fileName}
                        className="w-full h-full object-contain"
                        onContextMenu={(event) => event.preventDefault()}
                      />

                      {hasMultiple ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => albumViewerNavigate(-1)}
                            aria-label="Previous photo"
                            className="absolute left-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/60 hover:bg-background/80 backdrop-blur-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                          >
                            <ChevronLeft className="w-5 h-5" />
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => albumViewerNavigate(1)}
                            aria-label="Next photo"
                            className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/60 hover:bg-background/80 backdrop-blur-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto"
                          >
                            <ChevronRight className="w-5 h-5" />
                          </Button>

                          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] text-white tabular-nums">
                            {albumViewerState!.currentIndex + 1} / {albumViewerState!.images.length}
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>
        )
      })()}

      {/* Create folder dialog */}
      <InputDialog
        open={showCreateFolderDialog}
        onOpenChange={setShowCreateFolderDialog}
        title="Create Folder"
        label="Folder name"
        placeholder="e.g. Raw Files"
        confirmLabel="Create"
        onConfirm={confirmCreateUploadFolder}
        loading={isUploadActionBusy}
      />

      {/* Rename folder dialog */}
      <InputDialog
        open={showRenameFolderDialog}
        onOpenChange={(v) => { setShowRenameFolderDialog(v); if (!v) setRenameFolderTarget(null) }}
        title="Rename Folder"
        label="New folder name"
        defaultValue={renameFolderTarget?.name ?? ''}
        confirmLabel="Rename"
        onConfirm={confirmRenameUploadFolder}
        loading={isUploadActionBusy}
      />

      {/* Delete selected files dialog */}
      <ConfirmDialog
        open={showDeleteSelectedDialog}
        onOpenChange={setShowDeleteSelectedDialog}
        title={`Delete ${selectedUploadFilesInContext.length} Selected File${selectedUploadFilesInContext.length === 1 ? '' : 's'}?`}
        description="This will permanently delete the selected upload files. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteSelectedUploadFiles}
        loading={isUploadActionBusy}
      />

      {/* Delete single file dialog */}
      <ConfirmDialog
        open={pendingDeleteFileId !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteFileId(null) }}
        title="Delete File?"
        description="This will permanently delete the uploaded file. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteUploadFile}
        loading={isUploadActionBusy}
      />

      {/* Bulk download — unsupported browser advisory */}
      <ConfirmDialog
        open={bulkFsaUnsupportedFiles !== null}
        onOpenChange={(v) => { if (!v) setBulkFsaUnsupportedFiles(null) }}
        title="Use Chrome or Edge for large downloads"
        description={
          <span>
            Downloading {bulkFsaUnsupportedFiles?.length ?? 0} files directly to a folder requires{' '}
            <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong>, which support the File System Access API.
            Your current browser will download each file individually instead.
          </span>
        }
        confirmLabel="Download anyway"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={async () => {
          const files = bulkFsaUnsupportedFiles
          setBulkFsaUnsupportedFiles(null)
          if (!files?.length) return
          setIsDownloadingSelected(true)
          setLocalDownloadProgress(null)
          try {
            if (onDownloadFiles) {
              await onDownloadFiles(files, (progress) => setLocalDownloadProgress(progress))
            } else {
              await Promise.all(files.map((file) => onDownloadFile(file).catch(() => undefined)))
            }
          } finally {
            setIsDownloadingSelected(false)
            setLocalDownloadProgress(null)
          }
        }}
        onCancel={() => setBulkFsaUnsupportedFiles(null)}
      />

      {/* Delete folder dialog */}
      <ConfirmDialog
        open={pendingDeleteFolderPath !== null}
        onOpenChange={(v) => { if (!v) setPendingDeleteFolderPath(null) }}
        title="Delete Folder?"
        description="This will permanently delete the folder and all files inside it. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={confirmDeleteUploadFolder}
        loading={isUploadActionBusy}
      />

      {/* Approve video dialog */}
      <ConfirmDialog
        open={approveConfirmFile !== null}
        onOpenChange={(v) => { if (!v) { setApproveConfirmFile(null); setApproveConfirmVideoName('') } }}
        title="Approve Video"
        description={
          approveConfirmFile
            ? `Approve ${approveConfirmFile.versionLabel || 'this version'} for ${approveConfirmVideoName || approveConfirmFile.fileName}? If no changes are required, approve this video to download.`
            : 'Approve this version? If no changes are required, approve this video to download.'
        }
        confirmLabel={approving ? 'Approving...' : 'Approve'}
        cancelLabel="Cancel"
        variant="default"
        onConfirm={handleApproveVideo}
        loading={approving}
      />

      {/* Request next version dialog */}
      <ConfirmDialog
        open={requestNextFile !== null}
        onOpenChange={(v) => { if (!v) setRequestNextFile(null) }}
        title="Request Next Version"
        description={
          requestNextFile
            ? `Request the next version of ${openFolder?.name || requestNextFile.fileName}? Your feedback on ${requestNextFile.versionLabel || 'this version'} will be locked in, but you can still add comments.`
            : 'Request the next version? Your feedback on this version will be locked in, but you can still add comments.'
        }
        confirmLabel={requestingNext ? 'Requesting...' : 'Request Next Version'}
        cancelLabel="Cancel"
        variant="default"
        onConfirm={handleRequestNextVersion}
        loading={requestingNext}
      />

      <GuestVideoLinkDialog
        open={shareVideoId !== null}
        onOpenChange={(v) => { if (!v) setShareVideoId(null) }}
        projectId={projectId}
        videoId={shareVideoId}
        isAdminView={isAdmin}
        shareToken={shareToken}
      />

      <GuestAlbumLinkDialog
        open={shareAlbumId !== null}
        onOpenChange={(v) => { if (!v) setShareAlbumId(null) }}
        albumId={shareAlbumId}
        isAdminView={isAdmin}
        shareToken={shareToken}
      />

      {/* Right-click context menu */}
      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="fixed z-9999 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-elevation-lg text-popover-foreground"
              style={{
                left: Math.min(contextMenu.x, window.innerWidth - 220),
                top: Math.min(contextMenu.y, Math.max(4, window.innerHeight - 260)),
              }}
              onClick={() => setContextMenu(null)}
            >
              <ContextMenuItems
                contextMenu={contextMenu}
                file={contextMenu.file}
                group={contextMenu.group}
                canSelectFile={contextMenu.file ? isSelectableDownloadableFile(contextMenu.file, isAdmin) : false}
                isSelected={contextMenu.file ? selectedFileIds.has(getDownloadableFileKey(contextMenu.file)) : false}
                isGroupSelected={
                  contextMenu.group
                    ? (() => {
                        const files = getGroupSelectableFiles(contextMenu.group, isAdmin)
                        return files.length > 0 && files.every((f) => selectedFileIds.has(getDownloadableFileKey(f)))
                      })()
                    : false
                }
                canDownloadFile={contextMenu.file ? (contextMenu.file.type !== 'video' || isAdmin || contextMenu.file.isApproved !== false) : false}
                showApproveButton={contextMenu.file ? (
                  contextMenu.file.type === 'video' &&
                  contextMenu.file.isApproved === false &&
                  contextMenu.file.allowApproval === true &&
                  contextMenu.file.isRevisionRequested !== true &&
                  !!onApproveVideo &&
                  // Don't allow approving another version if one is already approved.
                  !((() => {
                    const folderName = openFolder?.name
                    if (!folderName) return false
                    const group = groups.find(
                      (g) => g.name === folderName && g.groupType === 'video'
                    )
                    if (!group) return false
                    return [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
                      .some((f) => f.type === 'video' && f.isApproved === true)
                  })())
                ) : false}
                fileKind={contextMenu.file ? getDownloadableFileKind(contextMenu.file) : null}
                isVideoAssetFile={contextMenu.file ? (getDownloadableFileKind(contextMenu.file) === 'video' && contextMenu.file.type !== 'video') : false}
                openFolder={openFolder}
                onPlay={() => {
                  if (contextMenu.file && onOpenVideoVersion) {
                    onOpenVideoVersion(contextMenu.file, openFolder?.name || null)
                  }
                }}
                onOpenDocument={
                  contextMenu.file && resolveDocumentViewUrl && isViewableDocumentFile(contextMenu.file)
                    ? () => openDocumentViewer(contextMenu.file!, contextMenu.imageList ?? [contextMenu.file!])
                    : null
                }
                onOpenLightbox={() => {
                  if (!contextMenu.file || !contextMenu.imageList) return
                  const kind = getDownloadableFileKind(contextMenu.file)
                  if (kind === 'image') {
                    openImageLightbox(contextMenu.file, contextMenu.imageList)
                  } else if (kind === 'video' && contextMenu.file.type !== 'video') {
                    openVideoLightbox(contextMenu.file, contextMenu.imageList)
                  } else if (kind === 'audio') {
                    openAudioLightbox(contextMenu.file, contextMenu.imageList)
                  }
                }}
                onOpenFolder={() => {
                  if (contextMenu.group) navigateToFolder(contextMenu.group.name)
                }}
                onSelect={() => {
                  if (!contextMenu.file) return
                  const key = getDownloadableFileKey(contextMenu.file)
                  toggleFile(key, !selectedFileIds.has(key))
                }}
                onDownload={() => {
                  if (contextMenu.file) void onDownloadFile(contextMenu.file)
                }}
                onDownloadFolder={() => {
                  if (!contextMenu.group) return
                  const files = [...(contextMenu.group.mainFile ? [contextMenu.group.mainFile] : []), ...contextMenu.group.subFiles]
                    .filter((f) => isSelectableDownloadableFile(f, isAdmin))
                  if (files.length > 0) {
                    if (onDownloadFiles) {
                      void onDownloadFiles(files)
                    } else {
                      void Promise.all(files.map((f) => onDownloadFile(f).catch(() => undefined)))
                    }
                  }
                }}
                onApprove={() => {
                  if (contextMenu.file) {
                    setApproveConfirmFile(contextMenu.file)
                    setApproveConfirmVideoName(openFolder?.name || contextMenu.file.fileName)
                  }
                }}
                onRenameFolder={() => {
                  if (!contextMenu.group) return
                  const path = getUploadsFolderPathFromGroup(contextMenu.group.name)
                  const label = getUploadsFolderLabelFromGroup(contextMenu.group.name)
                  renameUploadFolder(path, label.split('/').pop()?.trim() || label)
                }}
                onDeleteFolder={() => {
                  if (!contextMenu.group) return
                  const path = getUploadsFolderPathFromGroup(contextMenu.group.name)
                  deleteUploadFolder(path)
                }}
                onDeleteFile={() => {
                  if (contextMenu.file?.uploadFileId) {
                    deleteUploadFile(contextMenu.file.uploadFileId)
                  }
                }}
                canUploadAdmin={canDeleteUploads}
                onOpenAlbumPhoto={() => {
                  if (contextMenu.file && contextMenu.imageList) openImageLightbox(contextMenu.file, contextMenu.imageList)
                }}
                onSelectFolder={() => {
                  if (!contextMenu.group) return
                  const files = getGroupSelectableFiles(contextMenu.group, isAdmin)
                  if (files.length === 0) return
                  const allKeys = files.map((f) => getDownloadableFileKey(f))
                  const allSelected = allKeys.every((k) => selectedFileIds.has(k))
                  setSelectedFileIds((prev) => {
                    const next = new Set(prev)
                    if (allSelected) {
                      allKeys.forEach((k) => next.delete(k))
                    } else {
                      allKeys.forEach((k) => next.add(k))
                    }
                    return next
                  })
                }}
                albumPhotoSocialDownloadUrl={
                  contextMenu.file?.photoId && contextMenu.file?.albumId ? (
                    (() => {
                      const socialEnabled = albumSocialEnabledByAlbumId[contextMenu.file.albumId!] !== false
                      const meta = albumPhotoMetaByPhotoId[contextMenu.file.photoId!]
                      return socialEnabled && meta?.socialDownloadUrl && meta?.socialReady ? meta.socialDownloadUrl : null
                    })()
                  ) : null
                }
                onDownloadSocial={() => {
                  if (contextMenu.file?.photoId && contextMenu.file?.albumId) {
                    const meta = albumPhotoMetaByPhotoId[contextMenu.file.photoId]
                    if (meta?.socialDownloadUrl) triggerDirectDownload(meta.socialDownloadUrl)
                  }
                }}
                groupHasApprovedVersion={groupHasApprovedVersion}
                isAdmin={isAdmin}
              />
            </div>,
            document.body,
          )
        : null}

      {documentViewerState && resolveDocumentViewUrl ? (
        <DocumentViewerModal
          open
          onOpenChange={(next) => { if (!next) setDocumentViewerState(null) }}
          files={documentViewerState.files.map((f) => ({
            id: getDownloadableFileKey(f),
            fileName: f.fileName,
            fileSize: f.fileSizeBytes ?? null,
          }))}
          index={documentViewerState.currentIndex}
          onIndexChange={(nextIndex) =>
            setDocumentViewerState((prev) => (prev ? { ...prev, currentIndex: nextIndex } : prev))
          }
          resolveSrc={async (viewerFile) => {
            const match = documentViewerState.files.find(
              (f) => getDownloadableFileKey(f) === viewerFile.id
            )
            return match ? resolveDocumentViewUrl(match) : null
          }}
          onDownload={(viewerFile) => {
            const match = documentViewerState.files.find(
              (f) => getDownloadableFileKey(f) === viewerFile.id
            )
            if (match) void onDownloadFile(match)
          }}
        />
      ) : null}
    </div>
  )
}
