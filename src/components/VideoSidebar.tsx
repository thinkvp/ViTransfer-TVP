'use client'

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Play,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Images,
  Check,
  Download,
  Upload,
  Folder,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  X,
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api-client'
import Image from 'next/image'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import { ContextMenuItems } from '@/components/ShareFilesBrowser'
import { FolderPreviewMosaic } from '@/components/FolderPreviewMosaic'
import type { TransferItem, TransferSummary } from '@/lib/transfer-state'
import { ZIP_DOWNLOAD_THRESHOLD_BYTES } from '@/lib/transfer-state'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { InputDialog } from '@/components/ui/input-dialog'

interface VideoGroup {
  name: string
  videos: any[]
  versionCount: number
}

type DownloadProgressSnapshot = {
  percent: number
  speedBytesPerSecond: number | null
  etaSeconds: number | null
}

const SIDEBAR_CHECKBOX_CLASS = 'w-3.5 h-3.5 shrink-0 rounded accent-primary/75 opacity-70 checked:opacity-100 transition-opacity'
const UPLOADS_GROUP_PREFIX = 'UPLOADS / '

const isSelectableDownloadableFile = (file: DownloadableFile): boolean => {
  if (file.type !== 'video') return true
  return file.isApproved === true
}

const getUploadsRelativePath = (groupName: string): string => {
  if (groupName === 'UPLOADS') return ''
  if (groupName.startsWith(UPLOADS_GROUP_PREFIX)) return groupName.slice(UPLOADS_GROUP_PREFIX.length).trim()
  return groupName
}

const formatTransferSpeed = (bytesPerSecond: number | null): string => {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return 'Speed: --'
  }

  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let index = 0

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `Speed: ${value.toFixed(precision)} ${units[index]}`
}

const formatEta = (etaSeconds: number | null): string => {
  if (!etaSeconds || !Number.isFinite(etaSeconds) || etaSeconds <= 0) {
    return 'Time left: --'
  }

  const totalSeconds = Math.floor(etaSeconds)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  if (hours > 0) {
    return `Time left: ${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `Time left: ${minutes}:${String(seconds).padStart(2, '0')}`
}

const formatSelectedTotalSize = (bytes: number): string => {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const mb = safeBytes / (1024 * 1024)
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`
  }
  return `${mb.toFixed(2)} MB`
}

// Keep thumbnails aspect-correct inside a 16:9 container.
const calculateThumbnailDimensions = (
  videoWidth: number | null,
  videoHeight: number | null,
  containerWidth: number,
  containerHeight: number = Math.round(containerWidth * 9 / 16)
): { width: number; height: number; top: number; left: number } => {
  const vidWidth = videoWidth || 16
  const vidHeight = videoHeight || 9

  const videoAspectRatio = vidWidth / vidHeight
  const containerAspectRatio = containerWidth / containerHeight

  let finalWidth: number
  let finalHeight: number

  if (videoAspectRatio > containerAspectRatio) {
    finalWidth = containerWidth
    finalHeight = Math.round(containerWidth / videoAspectRatio)
  } else {
    finalHeight = containerHeight
    finalWidth = Math.round(containerHeight * videoAspectRatio)
  }

  const top = Math.round((containerHeight - finalHeight) / 2)
  const left = Math.round((containerWidth - finalWidth) / 2)

  return { width: finalWidth, height: finalHeight, top, left }
}

interface VideoSidebarProps {
  videosByName: Record<string, any[]>
  activeVideoName: string
  onVideoSelect: (videoName: string) => void
  albums?: Array<{ id: string; name: string; photoCount?: number; thumbnailPhotoUrl?: string | null }>
  activeAlbumId?: string | null
  onAlbumSelect?: (albumId: string) => void
  heading?: string
  showVideos?: boolean
  showAlbums?: boolean
  hideApprovalGrouping?: boolean
  className?: string
  initialCollapsed?: boolean
  /** If true, show the company logo at the top of the desktop sidebar */
  hasLogo?: boolean
  /** Main company domain — makes the logo a clickable link (opens in new tab) */
  mainCompanyDomain?: string | null
  showProjectHeadingLabel?: boolean
  showProjectSwitcher?: boolean
  onProjectSwitcherOpen?: () => void
  /** Structured list of downloadable files. Pass null/undefined to hide the FILES section (e.g. for guests). */
  downloadableFiles?: DownloadableGroup[] | null
  /** Called when the user clicks a file to download. Should fetch a token and trigger the download. */
  onDownloadFile?: (file: DownloadableFile) => Promise<void>
  /** Called when the user triggers a multi-file download. */
  onDownloadFiles?: (files: DownloadableFile[], onProgress?: (progress: DownloadProgressSnapshot) => void) => Promise<void>
  /** Shared progress state from the page-level download flow. */
  sharedDownloadProgress?: DownloadProgressSnapshot | null
  /** Indicates a download initiated elsewhere in the share page is active. */
  isSharedDownloadActive?: boolean
  /** Transfer items shown in the sidebar Transfers panel. */
  transferItems?: TransferItem[]
  /** Aggregate transfer state shown in the sidebar Transfers panel. */
  transferSummary?: TransferSummary | null
  /** Increments whenever a new transfer batch starts so the panel can reopen. */
  transferPanelVersion?: number
  /** Cancels the current app-managed transfers. */
  onCancelActiveTransfers?: () => void
  /** Clears completed transfer rows from the Transfers panel. */
  onClearCompletedTransfers?: () => void
  /** Whether the project has any videos with allowApproval=true, used for empty state messages. */
  hasApprovableVideos?: boolean
  /** Whether the desktop tab bar should be rendered inside the sidebar. */
  showDesktopTabBar?: boolean
  /** Render an UPLOADS folder entry inside the VIEW layout (combined files view). */
  showUploadsInView?: boolean
  /** Called when the UPLOADS entry in the VIEW layout is clicked (toggles the Files browser). */
  onUploadsSelect?: () => void
  /** Up to 3 resolved preview thumbnail URLs for the UPLOADS folder mosaic. */
  uploadsPreviewTiles?: string[]
  /** Video poster URL for the UPLOADS folder mosaic when no image tiles exist. */
  uploadsPreviewPoster?: string | null
  /** Called when an UPLOADS mosaic thumbnail fails to load (token expiry → refresh). */
  onUploadsPreviewError?: () => void
  /** Controlled desktop mode; when omitted, sidebar manages it internally. */
  desktopActiveTab?: 'for-review' | 'files'
  /** Controlled desktop mode setter. */
  onDesktopActiveTabChange?: (tab: 'for-review' | 'files') => void
  /** Controlled selected file IDs for files mode. */
  selectedFileIds?: Set<string>
  /** Controlled selected file IDs setter. */
  onSelectedFileIdsChange?: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Currently open folder in the main files display for row highlighting. */
  activeFilesFolderName?: string | null
  /** Called when the user clicks Play on a video in the context menu. */
  onOpenVideoVersion?: (file: DownloadableFile, folderName: string | null) => void
  /** Called when the user clicks Approve on an unapproved video in the context menu. */
  onApproveVideo?: (file: DownloadableFile) => Promise<void>
  /** Album social copy enabled state, keyed by albumId. */
  albumSocialEnabledByAlbumId?: Record<string, boolean>
  /** Album photo social download URLs, keyed by photoId. */
  albumPhotoMetaByPhotoId?: Record<string, { socialDownloadUrl: string; socialReady: boolean }>
  /** Share slug for API calls (album photo meta). */
  shareSlug?: string
  /** Bearer token for share API auth (album photo meta). */
  shareToken?: string | null
  /** Whether the current user can delete uploads. */
  canDeleteUploads?: boolean
  /** Delete an upload file by ID. */
  onDeleteUploadFile?: (fileId: string) => Promise<void>
  /** Delete an upload folder by path. */
  onDeleteUploadFolder?: (folderPath: string) => Promise<void>
  /** Rename an upload folder. */
  onRenameUploadFolder?: (folderPath: string, folderName: string) => Promise<void>
}


export default function VideoSidebar({
  videosByName,
  activeVideoName,
  onVideoSelect,
  albums,
  activeAlbumId,
  onAlbumSelect,
  heading,
  showVideos = true,
  showAlbums = true,
  hideApprovalGrouping = false,
  className,
  initialCollapsed = true,
  hasLogo = false,
  mainCompanyDomain,
  showProjectHeadingLabel = false,
  showProjectSwitcher = false,
  onProjectSwitcherOpen,
  downloadableFiles,
  onDownloadFile,
  onDownloadFiles,
  sharedDownloadProgress,
  isSharedDownloadActive = false,
  transferItems = [],
  transferSummary,
  transferPanelVersion = 0,
  onCancelActiveTransfers,
  onClearCompletedTransfers,
  hasApprovableVideos = false,
  showDesktopTabBar = true,
  showUploadsInView = false,
  onUploadsSelect,
  uploadsPreviewTiles = [],
  uploadsPreviewPoster = null,
  onUploadsPreviewError,
  desktopActiveTab,
  onDesktopActiveTabChange,
  selectedFileIds,
  onSelectedFileIdsChange,
  activeFilesFolderName,
  onOpenVideoVersion,
  onApproveVideo,
  albumSocialEnabledByAlbumId = {},
  albumPhotoMetaByPhotoId = {},
  shareSlug,
  shareToken,
  canDeleteUploads = false,
  onDeleteUploadFile,
  onDeleteUploadFolder,
  onRenameUploadFolder,
}: VideoSidebarProps) {
  const logoSrc = '/api/branding/logo'
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file?: DownloadableFile
    group?: DownloadableGroup & { folderGroupType?: string }
    imageList?: DownloadableFile[]
    openFolder?: { name: string; groupType: string } | null
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed)
  const [isMobileCollapsed, setIsMobileCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(256) // Default 256px (w-64)
  const [isResizing, setIsResizing] = useState(false)
  const [filesRatio, setFilesRatio] = useState(0.35)
  const [hasManualRatio, setHasManualRatio] = useState(false)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)
  const [isDownloadingAll, setIsDownloadingAll] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressSnapshot | null>(null)
  const [bulkFsaUnsupportedFiles, setBulkFsaUnsupportedFiles] = useState<DownloadableFile[] | null>(null)
  const [localDesktopActiveTab, setLocalDesktopActiveTab] = useState<'for-review' | 'files'>('for-review')
  const [localSelectedFileIds, setLocalSelectedFileIds] = useState<Set<string>>(new Set())
  const [isTransfersHidden, setIsTransfersHidden] = useState(true)
  const [showTransferCloseWarning, setShowTransferCloseWarning] = useState(false)
  const [transferPanelHeight, setTransferPanelHeight] = useState(208)
  const [isDraggingTransferPanel, setIsDraggingTransferPanel] = useState(false)
  const [collapsedFoldersByKey, setCollapsedFoldersByKey] = useState<Record<string, boolean>>({})
  const [albumMetaLoadedByAlbumId, setAlbumMetaLoadedByAlbumId] = useState<Record<string, boolean>>({})
  const [albumSocialEnabledByAlbumIdInternal, setAlbumSocialEnabledByAlbumIdInternal] = useState<Record<string, boolean>>({})
  const [albumPhotoMetaByPhotoIdInternal, setAlbumPhotoMetaByPhotoIdInternal] = useState<Record<string, { socialDownloadUrl: string; socialReady: boolean }>>({})
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ path: string; currentName: string } | null>(null)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ path: string; label: string } | null>(null)
  const [deleteFileTarget, setDeleteFileTarget] = useState<{ fileId: string; fileName: string } | null>(null)
  const [isUploadActionBusy, setIsUploadActionBusy] = useState(false)
  const autoClearUploadsTimeoutRef = useRef<number | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const mobileContainerRef = useRef<HTMLDivElement>(null)

  const desktopActiveTabValue = desktopActiveTab ?? localDesktopActiveTab
  const setDesktopActiveTabValue = onDesktopActiveTabChange ?? setLocalDesktopActiveTab
  const selectedFileIdsValue = selectedFileIds ?? localSelectedFileIds
  const setSelectedFileIdsValue = onSelectedFileIdsChange ?? setLocalSelectedFileIds

  const getFileIcon = (file: DownloadableFile) => {
    const kind = getDownloadableFileKind(file)
    if (kind === 'video') return FileVideo
    if (kind === 'image') return FileImage
    if (kind === 'audio') return FileAudio
    if (kind === 'archive') return FileArchive
    if (kind === 'document') return FileText
    return File
  }

  const compareFileNameAsc = (a: DownloadableFile, b: DownloadableFile) => {
    return String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, { sensitivity: 'base' })
  }

  const compareAlbumFilesForSidebar = (a: DownloadableFile, b: DownloadableFile) => {
    const getAlbumRank = (file: DownloadableFile): number => {
      if (file.type === 'album-zip') return 0
      if (file.type === 'album-photo') return 1
      return 2
    }

    const rankDiff = getAlbumRank(a) - getAlbumRank(b)
    if (rankDiff !== 0) return rankDiff

    return compareFileNameAsc(a, b)
  }

  const getVideoVersionNumber = (file: DownloadableFile): number | null => {
    const label = String(file.versionLabel || '').trim()
    if (!label) return null
    const match = label.match(/\d+/)
    if (!match) return null
    const value = Number(match[0])
    return Number.isFinite(value) ? value : null
  }

  const compareVideoVersionDesc = (a: DownloadableFile, b: DownloadableFile) => {
    const av = getVideoVersionNumber(a)
    const bv = getVideoVersionNumber(b)
    if (av != null && bv != null && av !== bv) {
      return bv - av
    }
    if (av != null && bv == null) return -1
    if (av == null && bv != null) return 1
    return compareFileNameAsc(a, b)
  }

  const safeVideosByName = videosByName || {}
  const videoGroups: VideoGroup[] = Object.entries(safeVideosByName).map(([name, videos]) => ({
    name,
    videos,
    versionCount: videos.length
  }))

  const albumsList = useMemo(() => {
    if (!Array.isArray(albums)) return []
    return [...albums].sort((a, b) => a.name.localeCompare(b.name))
  }, [albums])

  const shouldShowVideos = showVideos
  const shouldShowAlbums = showAlbums && albumsList.length > 0
  const hasVideos = shouldShowVideos && videoGroups.length > 0
  const hasAlbums = shouldShowAlbums && albumsList.length > 0

  const activeAlbum = useMemo(() => {
    if (!activeAlbumId) return null
    return albumsList.find((a) => a.id === activeAlbumId) || null
  }, [activeAlbumId, albumsList])

  const sortedVideoGroups = (groups: VideoGroup[]) => {
    return [...groups].sort((a, b) => a.name.localeCompare(b.name))
  }

  const isFolderCollapsed = useCallback((folderKey: string) => {
    return collapsedFoldersByKey[folderKey] === true
  }, [collapsedFoldersByKey])

  const toggleFolderCollapsed = useCallback((folderKey: string) => {
    setCollapsedFoldersByKey((prev) => ({
      ...prev,
      [folderKey]: !prev[folderKey],
    }))
  }, [])

  // In FILES mode, default-collapse all folders except the top PROJECT folder.
  // Only initialize missing keys so user toggles are preserved.
  useEffect(() => {
    if (desktopActiveTabValue !== 'files') return

    const uploadGroupNames = (downloadableFiles ?? [])
      .filter((group) => group.groupType === 'uploads' && group.name !== 'UPLOADS')
      .map((group) => group.name)

    setCollapsedFoldersByKey((prev) => {
      const next = { ...prev }
      let changed = false

      if (next['files:project-root'] === undefined) {
        next['files:project-root'] = false
        changed = true
      }

      const defaultCollapsedKeys = [
        'files:uploads-root',
        ...videoGroups.map((group) => `files:video:${group.name}`),
        ...albumsList.map((album) => `files:album:${album.id}`),
        ...uploadGroupNames.map((groupName) => `files:uploads:${groupName}`),
      ]

      for (const key of defaultCollapsedKeys) {
        if (next[key] !== undefined) continue
        next[key] = true
        changed = true
      }

      return changed ? next : prev
    })
  }, [albumsList, desktopActiveTabValue, downloadableFiles, videoGroups])

  // Load saved width from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('share_sidebar_width')
    if (saved) {
      const width = parseInt(saved, 10)
      if (width >= 200 && width <= window.innerWidth * 0.3) {
        setSidebarWidth(width)
      }
    }
  }, [])

  // Handle mouse move for resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return

      const newWidth = e.clientX
      const minWidth = 270
      const maxWidth = window.innerWidth * 0.3

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setSidebarWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false)
        localStorage.setItem('share_sidebar_width', sidebarWidth.toString())
      }
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, sidebarWidth])

  // Vertical split divider drag for FILES section
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider || !splitContainerRef.current) return
      const rect = splitContainerRef.current.getBoundingClientRect()
      const newRatio = 1 - (e.clientY - rect.top) / rect.height
      setHasManualRatio(true)
      setFilesRatio(Math.max(0.1, Math.min(0.85, newRatio)))
    }
    const handleMouseUp = () => {
      if (isDraggingDivider) setIsDraggingDivider(false)
    }
    if (isDraggingDivider) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDraggingDivider])

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  // Collapse mobile sidebar when clicking outside
  useEffect(() => {
    if (isMobileCollapsed) return
    const handleClickOutside = (e: MouseEvent) => {
      if (mobileContainerRef.current && !mobileContainerRef.current.contains(e.target as Node)) {
        setIsMobileCollapsed(true)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isMobileCollapsed])

  // Close context menu when clicking outside or pressing Escape
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
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  // Load album photo meta for social download support (shared with context menu)
  const loadAlbumPhotoMeta = useCallback(async (albumId: string | null, slug: string | null) => {
    if (!albumId || !slug) return
    if (albumMetaLoadedByAlbumId[albumId]) return

    try {
      const res = await apiFetch(`/api/share/${encodeURIComponent(slug)}/albums/${encodeURIComponent(albumId)}`, {
        cache: 'no-store',
        headers: shareToken ? { Authorization: `Bearer ${shareToken}` } : undefined,
      })
      if (!res.ok) return

      const data = await res.json().catch(() => ({}))
      const photos = Array.isArray((data as any)?.photos) ? (data as any).photos : []
      const socialEnabled = (data as any)?.album?.socialCopiesEnabled !== false

      setAlbumMetaLoadedByAlbumId((prev) => ({ ...prev, [albumId]: true }))
      setAlbumSocialEnabledByAlbumIdInternal((prev) => ({ ...prev, [albumId]: socialEnabled }))
      setAlbumPhotoMetaByPhotoIdInternal((prev) => {
        const next = { ...prev }
        for (const photo of photos) {
          const photoId = typeof photo?.id === 'string' ? photo.id : ''
          const socialDownloadUrl = typeof photo?.socialDownloadUrl === 'string' ? photo.socialDownloadUrl : ''
          if (!photoId || !socialDownloadUrl) continue
          next[photoId] = { socialDownloadUrl, socialReady: photo?.socialReady === true }
        }
        return next
      })
    } catch {
      // ignore
    }
  }, [albumMetaLoadedByAlbumId, shareToken])

  // Preload album photo meta for sidebar context menu
  useEffect(() => {
    if (desktopActiveTabValue !== 'files' || !shareSlug) return
    for (const group of downloadableFiles ?? []) {
      if (group.groupType === 'album') {
        for (const file of group.subFiles) {
          if (file.albumId) {
            void loadAlbumPhotoMeta(file.albumId, shareSlug)
            break
          }
        }
      }
    }
  }, [desktopActiveTabValue, downloadableFiles, loadAlbumPhotoMeta, shareSlug])

  const queueSidebarDownloads = useCallback(async (files: DownloadableFile[], withProgress?: boolean) => {
    if (!files.length) return

    if (onDownloadFiles) {
      if (withProgress) {
        await onDownloadFiles(files, (progress) => setDownloadProgress(progress))
      } else {
        await onDownloadFiles(files)
      }
      return
    }

    if (!onDownloadFile) return

    for (let i = 0; i < files.length; i += 1) {
      await onDownloadFile(files[i])
    }
  }, [onDownloadFile, onDownloadFiles])

  // Build a lookup from file key → group so download handlers can annotate files with
  // the correct downloadFolderPath (used by ZIP and FSA bulk downloads for folder structure).
  const annotateFilesWithFolderPath = useCallback((files: DownloadableFile[]): DownloadableFile[] => {
    if (!downloadableFiles) return files
    const fileKeyToGroup = new Map<string, DownloadableGroup>()
    for (const group of downloadableFiles) {
      for (const file of [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]) {
        fileKeyToGroup.set(getDownloadableFileKey(file), group)
      }
    }
    return files.map((file) => {
      const group = fileKeyToGroup.get(getDownloadableFileKey(file))
      if (!group) return file
      if (group.groupType === 'uploads') {
        const parts = ['UPLOADS', ...(file.uploadFolderPath?.split('/').filter(Boolean) ?? [])]
        return { ...file, downloadFolderPath: parts.join('/') }
      }
      return { ...file, downloadFolderPath: group.name }
    })
  }, [downloadableFiles])

  const handleDownloadAll = useCallback(async () => {
    if (!downloadableFiles || (!onDownloadFile && !onDownloadFiles)) return
    setIsDownloadingAll(true)
    try {
      const allFiles = annotateFilesWithFolderPath(downloadableFiles.flatMap((g) => [
        ...(g.mainFile ? [g.mainFile] : []),
        ...g.subFiles,
      ]))
      const totalBytes = allFiles.reduce((s, f) => s + (f.fileSizeBytes != null ? Number(f.fileSizeBytes) : 0), 0)
      const isFsaAvailable = typeof window !== 'undefined' && 'showDirectoryPicker' in window
      if (totalBytes > ZIP_DOWNLOAD_THRESHOLD_BYTES && !isFsaAvailable) {
        setBulkFsaUnsupportedFiles(allFiles)
        return
      }
      await queueSidebarDownloads(allFiles)
    } finally {
      setIsDownloadingAll(false)
    }
  }, [annotateFilesWithFolderPath, downloadableFiles, onDownloadFile, onDownloadFiles, queueSidebarDownloads])

  const handleDownloadSelected = useCallback(async () => {
    if (!downloadableFiles || (!onDownloadFile && !onDownloadFiles) || selectedFileIdsValue.size === 0) return
    setIsDownloadingAll(true)
    setDownloadProgress(null)
    try {
      const allFiles = annotateFilesWithFolderPath(downloadableFiles.flatMap((g) => [
        ...(g.mainFile ? [g.mainFile] : []),
        ...g.subFiles,
      ]))
      const toDownload = allFiles.filter((file) => {
        const key = getDownloadableFileKey(file)
        return selectedFileIdsValue.has(key) && isSelectableDownloadableFile(file)
      })
      const totalBytes = toDownload.reduce((s, f) => s + (f.fileSizeBytes != null ? Number(f.fileSizeBytes) : 0), 0)
      const isFsaAvailable = typeof window !== 'undefined' && 'showDirectoryPicker' in window
      if (totalBytes > ZIP_DOWNLOAD_THRESHOLD_BYTES && !isFsaAvailable) {
        setBulkFsaUnsupportedFiles(toDownload)
        return
      }
      await queueSidebarDownloads(toDownload, true)
    } finally {
      setIsDownloadingAll(false)
      setDownloadProgress(null)
    }
  }, [annotateFilesWithFolderPath, downloadableFiles, onDownloadFile, onDownloadFiles, queueSidebarDownloads, selectedFileIdsValue])

  const handleSelectAll = useCallback(() => {
    if (!downloadableFiles) return
    const allKeys = downloadableFiles
      .flatMap((g) => [...(g.mainFile ? [g.mainFile] : []), ...g.subFiles])
      .filter((file) => isSelectableDownloadableFile(file))
      .map((file) => getDownloadableFileKey(file))
    setSelectedFileIdsValue(new Set(allKeys))
  }, [downloadableFiles, setSelectedFileIdsValue])

  useEffect(() => {
    if (!downloadableFiles) return

    const selectableKeys = new Set(
      downloadableFiles
        .flatMap((g) => [...(g.mainFile ? [g.mainFile] : []), ...g.subFiles])
        .filter((file) => isSelectableDownloadableFile(file))
        .map((file) => getDownloadableFileKey(file))
    )

    setSelectedFileIdsValue((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((key) => selectableKeys.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [downloadableFiles, setSelectedFileIdsValue])

  const handleClearSelected = useCallback(() => {
    setSelectedFileIdsValue(new Set())
  }, [setSelectedFileIdsValue])

  const showFiles = downloadableFiles !== undefined && downloadableFiles !== null
  const isMobileFilesMode = desktopActiveTabValue === 'files'
  const hasTransferItems = transferItems.length > 0
  const hasActiveDownloadTransfers = transferItems.some((transfer) => (
    transfer.direction === 'download' && ['queued', 'preparing', 'transferring'].includes(transfer.status)
  ))
  const hasDismissibleTransfers = transferItems.some((transfer) => !['queued', 'preparing', 'transferring'].includes(transfer.status))
  const effectiveDownloadProgress = isDownloadingAll ? downloadProgress : sharedDownloadProgress
  const showDownloadProgress = (isDownloadingAll || hasActiveDownloadTransfers) && effectiveDownloadProgress !== null
  const effectiveProgressPercent = effectiveDownloadProgress?.percent ?? 0
  const effectiveSpeed = effectiveDownloadProgress?.speedBytesPerSecond ?? null
  const effectiveEta = effectiveDownloadProgress?.etaSeconds ?? null
  const hasActiveTransferMetrics = Boolean(transferSummary?.activeCount)
  const selectedFilesTotalSizeBytes = useMemo(() => {
    if (!downloadableFiles || selectedFileIdsValue.size === 0) return 0

    const fileByKey = new Map<string, DownloadableFile>()
    downloadableFiles.forEach((group) => {
      ;[...(group.mainFile ? [group.mainFile] : []), ...group.subFiles].forEach((file) => {
        fileByKey.set(getDownloadableFileKey(file), file)
      })
    })

    return Array.from(selectedFileIdsValue).reduce((total, key) => {
      const file = fileByKey.get(key)
      if (!file) return total
      const rawSize = typeof file.fileSizeBytes === 'string' ? Number(file.fileSizeBytes) : file.fileSizeBytes
      const size = Number.isFinite(rawSize) && (rawSize as number) > 0 ? Number(rawSize) : 0
      return total + size
    }, 0)
  }, [downloadableFiles, selectedFileIdsValue])

  const canOpenProjectSwitcher = showProjectSwitcher && typeof onProjectSwitcherOpen === 'function'

  // Desktop sidebar thumbnails scale up as the sidebar is widened; the current
  // sizes are the floor. Base width 256px → 64px video/album thumbnail (w-16).
  // Video/album thumbnails stay 16:9; the uploads mosaic shares the same width.
  const thumbnailScale = Math.max(1, sidebarWidth / 256)
  const videoThumbnailWidth = Math.round(64 * thumbnailScale)
  const videoThumbnailHeight = Math.round((videoThumbnailWidth * 9) / 16)
  const uploadsThumbnailWidth = videoThumbnailWidth

  // Desktop sidebar: computed groups and render helpers (mobile section is unchanged)
  const forReviewGroups = sortedVideoGroups(videoGroups.filter(g => !g.videos.some((v: any) => v.approved === true)))
  const approvedGroups = sortedVideoGroups(videoGroups.filter(g => g.videos.some((v: any) => v.approved === true)))
  const flatAlphabeticalGroups = sortedVideoGroups(videoGroups)
  // Show bottom section: FILES for hideApprovalGrouping; APPROVED section whenever there are approved videos, albums, or downloadable files
  const showBottomSection = hideApprovalGrouping ? showFiles : (approvedGroups.length > 0 || hasAlbums || showFiles)

  // Auto-size the split ratio based on item counts (resets on content change unless user has manually dragged)
  useEffect(() => {
    if (hasManualRatio || hideApprovalGrouping) return
    const topCount = Math.max(forReviewGroups.length, 1)
    const bottomCount = approvedGroups.length + albumsList.length
    if (bottomCount === 0) return
    // Bottom items are taller (thumbnail + name + file listings) — weight ~3x
    const bottomWeight = bottomCount * 3
    const newRatio = bottomWeight / (topCount + bottomWeight)
    setFilesRatio(Math.max(0.2, Math.min(0.8, newRatio)))
  }, [forReviewGroups.length, approvedGroups.length, albumsList.length, hideApprovalGrouping, hasManualRatio])

  useEffect(() => {
    if (transferPanelVersion > 0 && hasTransferItems) {
      setIsTransfersHidden(false)
    }
  }, [hasTransferItems, transferPanelVersion])

  useEffect(() => {
    if (autoClearUploadsTimeoutRef.current != null) {
      window.clearTimeout(autoClearUploadsTimeoutRef.current)
      autoClearUploadsTimeoutRef.current = null
    }

    if (!onClearCompletedTransfers || transferItems.length === 0) return

    const finishedNonUploadCount = transferItems.filter((item) => {
      if (item.direction === 'upload') return false
      return ['completed', 'failed', 'canceled', 'browser'].includes(item.status)
    }).length

    const completedUploadCount = transferItems.filter((item) => {
      return item.direction === 'upload'
        && item.status === 'completed'
        && Math.round(item.progressPercent) >= 100
    }).length

    if (completedUploadCount === 0 || finishedNonUploadCount > 0) return

    autoClearUploadsTimeoutRef.current = window.setTimeout(() => {
      onClearCompletedTransfers()
      autoClearUploadsTimeoutRef.current = null
    }, 2000)

    return () => {
      if (autoClearUploadsTimeoutRef.current != null) {
        window.clearTimeout(autoClearUploadsTimeoutRef.current)
        autoClearUploadsTimeoutRef.current = null
      }
    }
  }, [onClearCompletedTransfers, transferItems])

  useEffect(() => {
    const saved = localStorage.getItem('share_transfers_height')
    if (!saved) return
    const height = parseInt(saved, 10)
    if (height >= 140 && height <= 600) {
      setTransferPanelHeight(height)
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingTransferPanel || !sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const nextHeight = rect.bottom - e.clientY
      const minHeight = 140
      const maxHeight = Math.max(180, Math.min(600, Math.round(rect.height * 0.75)))
      setTransferPanelHeight(Math.max(minHeight, Math.min(maxHeight, nextHeight)))
    }

    const handleMouseUp = () => {
      if (!isDraggingTransferPanel) return
      setIsDraggingTransferPanel(false)
      localStorage.setItem('share_transfers_height', transferPanelHeight.toString())
    }

    if (isDraggingTransferPanel) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDraggingTransferPanel, transferPanelHeight])

  const handleCloseTransfers = useCallback(() => {
    if (isSharedDownloadActive) {
      setShowTransferCloseWarning(true)
      return
    }

    setIsTransfersHidden(true)
  }, [isSharedDownloadActive])

  const handleConfirmCloseTransfers = useCallback(() => {
    setShowTransferCloseWarning(false)
    onCancelActiveTransfers?.()
    setIsTransfersHidden(true)
  }, [onCancelActiveTransfers])

  const getTransferStatusLabel = (transfer: TransferItem) => {
    switch (transfer.status) {
      case 'queued':
        return 'Queued'
      case 'preparing':
        return 'Preparing'
      case 'transferring':
        return transfer.direction === 'upload' ? 'Uploading' : 'Downloading'
      case 'browser':
        return 'Opened in browser downloads'
      case 'completed':
        return 'Complete'
      case 'failed':
        return 'Failed'
      case 'canceled':
        return 'Canceled'
      default:
        return transfer.status
    }
  }

  const renderTransfersSection = (isMobile = false) => {
    if (!hasTransferItems || isTransfersHidden) return null

    return (
      <div className={cn('border-t border-border bg-card/95 backdrop-blur-sm', isMobile ? 'mt-2' : 'flex-shrink-0')}>
        {!isMobile && (
          <div
            className="flex h-[5px] cursor-row-resize items-center justify-center bg-border transition-colors hover:bg-primary/20"
            onMouseDown={(event) => {
              event.preventDefault()
              setIsDraggingTransferPanel(true)
            }}
          >
            <div className="h-0.5 w-8 rounded-full bg-muted-foreground/30" />
          </div>
        )}
        <div
          className="flex flex-col px-3 py-2 gap-2"
          style={!isMobile ? { height: `${transferPanelHeight}px` } : undefined}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Transfers</div>
              <div className="text-[11px] text-muted-foreground">
                {transferSummary?.activeCount
                  ? `${transferSummary.activeCount} active of ${transferSummary.totalCount}`
                  : `${transferItems.length} item${transferItems.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCloseTransfers}
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close transfers"
              title="Close transfers"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {hasActiveTransferMetrics ? (
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>{formatTransferSpeed(transferSummary?.speedBytesPerSecond ?? null)}</span>
              <span>{formatEta(transferSummary?.etaSeconds ?? null)}</span>
            </div>
          ) : null}

          {hasDismissibleTransfers && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClearCompletedTransfers}
                className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear Finished
              </button>
            </div>
          )}

          <div className={cn('space-y-1.5 overflow-y-auto', isMobile ? 'max-h-40' : 'flex-1 min-h-0')}>
            {transferItems.map((transfer) => {
              const DirectionIcon = transfer.direction === 'upload' ? Upload : Download
              const statusLabel = getTransferStatusLabel(transfer)

              return (
                <div key={transfer.id} className="rounded-md border border-border/70 bg-background/70 px-2 py-2">
                  <div className="flex items-start gap-2">
                    <DirectionIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-xs font-medium text-foreground" title={transfer.fileName}>
                          {transfer.fileName}
                        </p>
                        {transfer.status !== 'browser' ? (
                          <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">
                            {Math.round(transfer.progressPercent)}%
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{statusLabel}</div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            'h-full transition-all',
                            transfer.status === 'failed'
                              ? 'bg-destructive'
                              : transfer.status === 'canceled'
                                ? 'bg-warning'
                                : 'bg-primary'
                          )}
                          style={{ width: `${Math.max(0, Math.min(100, transfer.progressPercent))}%` }}
                        />
                      </div>
                      {transfer.errorMessage && (
                        <div
                          className={cn(
                            'mt-1 text-[11px]',
                            transfer.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                          )}
                        >
                          {transfer.errorMessage}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderVideoButton = (group: VideoGroup, showDownloadFiles = false) => {
    const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
    const isActive = !activeAlbumId && activeVideoName === group.name
    const latestVideo = group.videos[0]
    const approvedVideo = group.videos.find((v: any) => v.approved === true)
    const displayVideo = approvedVideo || latestVideo
    const thumbnailUrl = displayVideo?.thumbnailUrl

    const downloadGroup = showDownloadFiles && downloadableFiles
      ? downloadableFiles.find(dg => dg.name === group.name)
      : null
    const downloadFiles = downloadGroup
      ? [...(downloadGroup.mainFile ? [downloadGroup.mainFile] : []), ...downloadGroup.subFiles]
      : []

    const thumbnailEl = (
      <div
        className="flex-shrink-0 rounded overflow-hidden bg-black flex items-center justify-center relative"
        style={{ width: videoThumbnailWidth, height: videoThumbnailHeight }}
      >
        {thumbnailUrl ? (
          <Image
            src={thumbnailUrl}
            alt={group.name}
            fill
            className="object-contain"
            unoptimized
            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.visibility = 'hidden' }}
          />
        ) : (
          <Play className="w-4 h-4 text-muted-foreground/50" />
        )}
      </div>
    )

    const titleEl = (
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-snug line-clamp-2 break-words">{group.name}</p>
        {!showDownloadFiles && (
          <p className="text-xs text-muted-foreground">
            {hideApprovalGrouping && latestVideo?.versionLabel
              ? latestVideo.versionLabel
              : `${group.versionCount} ${group.versionCount === 1 ? 'version' : 'versions'}`}
          </p>
        )}
      </div>
    )

    if (showDownloadFiles) {
      return (
        <div
          key={group.name}
          className={cn(
            'rounded-lg overflow-hidden transition-all duration-200',
            isActive ? 'bg-primary/10 border border-primary/20' : ''
          )}
        >
          <button
            onClick={() => onVideoSelect(group.name)}
            className={cn(
              'w-full text-left px-2 py-2 flex flex-row items-start gap-2',
              'hover:bg-accent hover:text-accent-foreground transition-colors',
              isActive ? 'text-primary font-medium' : 'text-foreground'
            )}
          >
            {thumbnailEl}
            {titleEl}
          </button>
          {downloadFiles.length > 0 && (
            <div className="px-3 pb-2 space-y-0.5">
              {downloadFiles.map(file => (
                <button
                  key={getDownloadableFileKey(file)}
                  onClick={() => void onDownloadFile?.(file)}
                  className="w-full text-left text-xs text-muted-foreground hover:text-foreground truncate flex items-center gap-1.5 py-0.5 transition-colors"
                  title={file.fileName}
                >
                  <Download className="w-3 h-3 shrink-0" />
                  {file.fileName}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }

    return (
      <button
        key={group.name}
        onClick={() => onVideoSelect(group.name)}
        className={cn(
          'w-full text-left px-2 py-2 rounded-lg transition-all duration-200 flex flex-row items-start gap-2',
          'hover:bg-accent hover:text-accent-foreground',
          isActive
            ? 'bg-primary/10 text-primary font-medium border border-primary/20'
            : 'text-foreground'
        )}
      >
        {thumbnailEl}
        {titleEl}
        {isActive && (
          hasApprovedVideo ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-success mt-0.5" />
          ) : (
            <Play className="w-4 h-4 shrink-0 text-primary mt-0.5" fill="currentColor" />
          )
        )}
      </button>
    )
  }

  const renderAlbumButton = (a: typeof albumsList[0], showDownloadFiles = false) => {
    const isActive = activeAlbumId === a.id
    const previewUrl = (a as any)?.thumbnailPhotoUrl as string | null | undefined

    const downloadGroup = showDownloadFiles && downloadableFiles
      ? downloadableFiles.find(dg => dg.name === a.name)
      : null
    const downloadFiles = downloadGroup
      ? [...(downloadGroup.mainFile ? [downloadGroup.mainFile] : []), ...downloadGroup.subFiles]
      : []

    const thumbnailEl = (
      <div
        className="flex-shrink-0 rounded overflow-hidden relative bg-gradient-to-br from-muted to-muted-foreground/50 flex items-center justify-center"
        style={{ width: videoThumbnailWidth, height: videoThumbnailHeight }}
      >
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={a.name}
            className="absolute inset-0 w-full h-full object-cover"
            loading={isActive ? 'eager' : 'lazy'}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        )}
        <Images className="w-4 h-4 text-muted-foreground/70 relative z-10" />
      </div>
    )

    const titleEl = (
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-snug line-clamp-2 break-words">{a.name}</p>
        {!showDownloadFiles && (
          <p className="text-xs text-muted-foreground">
            {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
          </p>
        )}
      </div>
    )

    if (showDownloadFiles) {
      return (
        <div
          key={a.id}
          className={cn(
            'rounded-lg overflow-hidden transition-all duration-200',
            isActive ? 'bg-primary/10 border border-primary/20' : ''
          )}
        >
          <button
            onClick={() => onAlbumSelect?.(a.id)}
            className={cn(
              'w-full text-left px-2 py-2 flex flex-row items-start gap-2',
              'hover:bg-accent hover:text-accent-foreground transition-colors',
              isActive ? 'text-primary font-medium' : 'text-foreground'
            )}
          >
            {thumbnailEl}
            {titleEl}
          </button>
          {downloadFiles.length > 0 && (
            <div className="px-3 pb-2 space-y-0.5">
              {downloadFiles.map(file => (
                <button
                  key={getDownloadableFileKey(file)}
                  onClick={() => void onDownloadFile?.(file)}
                  className="w-full text-left text-xs text-muted-foreground hover:text-foreground truncate flex items-center gap-1.5 py-0.5 transition-colors"
                  title={file.fileName}
                >
                  <Download className="w-3 h-3 shrink-0" />
                  {file.fileName}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }

    return (
      <button
        key={a.id}
        onClick={() => onAlbumSelect?.(a.id)}
        className={cn(
          'w-full text-left px-2 py-2 rounded-lg transition-all duration-200 flex flex-row items-start gap-2',
          'hover:bg-accent hover:text-accent-foreground',
          isActive
            ? 'bg-primary/10 text-primary font-medium border border-primary/20'
            : 'text-foreground'
        )}
      >
        {thumbnailEl}
        {titleEl}
      </button>
    )
  }

  // Combined files view: a single clickable UPLOADS folder rendered inside the VIEW
  // layout. Clicking it opens UPLOADS in the Files browser (and toggles back to root).
  const renderUploadsViewButton = () => {
    const uploadGroups = (downloadableFiles ?? []).filter((group) => group.groupType === 'uploads')
    const hasUploads = uploadGroups.length > 0
    if (!hasUploads) return null
    const isActive = String(activeFilesFolderName || '').trim().startsWith('UPLOADS')
    const totalFileCount = uploadGroups.reduce((count, group) => {
      return count + (group.mainFile ? 1 : 0) + group.subFiles.length
    }, 0)
    return (
      <div className="mt-4 border-t border-border pt-3">
        <div className="px-3 py-2 text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
          <Upload className="w-3 h-3" />
          Uploads
        </div>
        <button
          type="button"
          onClick={() => onUploadsSelect?.()}
          className={cn(
            'w-full text-left px-2 py-2 rounded-lg transition-all duration-200 flex flex-row items-start gap-2',
            'hover:bg-accent hover:text-accent-foreground',
            isActive ? 'bg-primary/10 text-primary font-medium border border-primary/20' : 'text-foreground'
          )}
        >
          <div className="flex-shrink-0" style={{ width: uploadsThumbnailWidth }}>
            <FolderPreviewMosaic
              label="UPLOADS"
              tiles={uploadsPreviewTiles}
              videoPoster={uploadsPreviewPoster}
              isUploads
              onTileError={onUploadsPreviewError}
            />
          </div>
          <div className="flex-1 min-w-0 pt-2">
            <p className="text-sm font-semibold leading-snug">UPLOADS</p>
            <p className="text-xs text-muted-foreground">
              {totalFileCount} {totalFileCount === 1 ? 'file' : 'files'}
            </p>
          </div>
        </button>
      </div>
    )
  }

  const renderFilesTabSection = (isMobile = false) => {
    const uploadGroups = (downloadableFiles ?? []).filter((group) => group.groupType === 'uploads')
    const hasUploads = uploadGroups.length > 0
    const uploadRootGroup = uploadGroups.find((group) => group.name === 'UPLOADS') ?? null
    const uploadRootFiles = uploadRootGroup
      ? [...(uploadRootGroup.mainFile ? [uploadRootGroup.mainFile] : []), ...uploadRootGroup.subFiles]
      : []
    const sortedUploadRootFiles = [...uploadRootFiles].sort(compareFileNameAsc)
    const nestedUploadGroups = uploadGroups
      .filter((group) => group.name !== 'UPLOADS')
      .sort((a, b) => getUploadsRelativePath(a.name).localeCompare(getUploadsRelativePath(b.name), undefined, { sensitivity: 'base' }))
    const uploadRootFileKeys = uploadGroups
      .flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
      .map((file) => getDownloadableFileKey(file))
    const allUploadsSelected = uploadRootFileKeys.length > 0 && uploadRootFileKeys.every((key) => selectedFileIdsValue.has(key))
    const someUploadsSelected = uploadRootFileKeys.some((key) => selectedFileIdsValue.has(key))
    const isUploadsRootActive = String(activeFilesFolderName || '').trim().startsWith('UPLOADS')
    const allProjectFileKeys = (downloadableFiles ?? [])
      .filter((group) => group.groupType !== 'uploads')
      .flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
      .filter((file) => isSelectableDownloadableFile(file))
      .map((file) => getDownloadableFileKey(file))
    const allProjectSelected = allProjectFileKeys.length > 0 && allProjectFileKeys.every((key) => selectedFileIdsValue.has(key))
    const someProjectSelected = allProjectFileKeys.some((key) => selectedFileIdsValue.has(key))
    const projectLabel = String(heading || 'Project').trim() || 'Project'
    const isRootFilesFolderActive = String(activeFilesFolderName || '').trim().length === 0
    const projectRootFolderKey = 'files:project-root'
    const isProjectRootCollapsed = isFolderCollapsed(projectRootFolderKey)
    const uploadsRootFolderKey = 'files:uploads-root'
    const isUploadsRootCollapsed = isFolderCollapsed(uploadsRootFolderKey)

    return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className={cn('overflow-y-auto overflow-x-hidden flex-1', !isMobile && 'mr-[5px]')}>
        {!hasVideos && !hasAlbums && !hasUploads ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No content available for download.</p>
        ) : (
          <div className="py-2">
            <div className={cn('flex items-center gap-2 px-3 pt-2 pb-1', isRootFilesFolderActive && 'rounded-md bg-primary/15')}>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label={isProjectRootCollapsed ? `Expand ${projectLabel}` : `Collapse ${projectLabel}`}
                onClick={() => toggleFolderCollapsed(projectRootFolderKey)}
              >
                {isProjectRootCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              <input
                type="checkbox"
                checked={allProjectSelected}
                disabled={allProjectFileKeys.length === 0}
                ref={(el) => { if (el) el.indeterminate = someProjectSelected && !allProjectSelected }}
                onChange={() => {
                  if (allProjectSelected) {
                    setSelectedFileIdsValue(new Set())
                  } else {
                    setSelectedFileIdsValue(new Set(allProjectFileKeys))
                  }
                }}
                className={cn(
                  SIDEBAR_CHECKBOX_CLASS,
                  allProjectFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                )}
                aria-label={`Select all files in ${projectLabel}`}
              />
              <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
              <button
                type="button"
                className={cn(
                  'text-sm font-semibold truncate text-left hover:underline',
                  isRootFilesFolderActive ? 'text-primary' : 'text-foreground'
                )}
                title={`Open ${projectLabel} root folder`}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('shareOpenFilesRoot'))
                }}
              >
                PROJECT
              </button>
            </div>

            {!isProjectRootCollapsed && sortedVideoGroups(videoGroups).map((vg) => {
              const dlGroup = downloadableFiles?.find((g) => g.name === vg.name && g.groupType === 'video') ?? null
              const groupFilesRaw: DownloadableFile[] = dlGroup
                ? [...(dlGroup.mainFile ? [dlGroup.mainFile] : []), ...dlGroup.subFiles]
                : []
              const sortedVideoFiles = [...groupFilesRaw.filter((f) => f.type === 'video')].sort(compareVideoVersionDesc)
              const sortedNonVideoFiles = [...groupFilesRaw.filter((f) => f.type !== 'video')].sort(compareFileNameAsc)
              const orderedGroupFiles: DownloadableFile[] = [
                ...sortedVideoFiles,
                ...sortedNonVideoFiles,
              ]
              const isActiveFolder = activeFilesFolderName === vg.name
              const groupFileKeys = orderedGroupFiles
                .filter((f) => isSelectableDownloadableFile(f))
                .map((f) => getDownloadableFileKey(f))
              const allGroupSelected = groupFileKeys.length > 0 && groupFileKeys.every((k) => selectedFileIdsValue.has(k))
              const someGroupSelected = groupFileKeys.some((k) => selectedFileIdsValue.has(k))
              const videoFolderKey = `files:video:${vg.name}`
              const isVideoFolderCollapsed = isFolderCollapsed(videoFolderKey)
              const openMainFilesFolder = () => {
                onVideoSelect(vg.name)
                window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                  detail: { folderName: vg.name },
                }))
              }
              const openVideoVersionInView = (videoFile: DownloadableFile) => {
                if (videoFile.type !== 'video' || !videoFile.videoId) return
                onVideoSelect(vg.name)
                setDesktopActiveTabValue('for-review')
                setTimeout(() => {
                  window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId: videoFile.videoId } }))
                  window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId: videoFile.videoId } }))
                  window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: videoFile.videoId, videoVersion: null } }))
                }, 0)
              }
              return (
                <div key={vg.name}>
                  <div
                    className={cn('flex items-center gap-2 pl-6 pr-3 pt-2 pb-1', isActiveFolder && 'rounded-md bg-primary/15')}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!dlGroup) return
                      setContextMenu({ x: e.clientX, y: e.clientY, group: dlGroup, openFolder: { name: vg.name, groupType: 'video' } })
                    }}
                  >
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={isVideoFolderCollapsed ? `Expand ${vg.name}` : `Collapse ${vg.name}`}
                      onClick={() => toggleFolderCollapsed(videoFolderKey)}
                    >
                      {isVideoFolderCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <input
                      type="checkbox"
                      checked={allGroupSelected}
                      disabled={groupFileKeys.length === 0}
                      ref={(el) => { if (el) el.indeterminate = someGroupSelected && !allGroupSelected }}
                      onChange={() => {
                        setSelectedFileIdsValue((prev) => {
                          const next = new Set(prev)
                          if (allGroupSelected) {
                            groupFileKeys.forEach((k) => next.delete(k))
                          } else {
                            groupFileKeys.forEach((k) => next.add(k))
                          }
                          return next
                        })
                      }}
                      className={cn(
                        SIDEBAR_CHECKBOX_CLASS,
                        groupFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                    />
                    <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                    <button
                      type="button"
                      className="text-sm font-semibold text-foreground truncate text-left hover:underline"
                      onClick={openMainFilesFolder}
                      title={`Open ${vg.name} in Files`}
                    >
                      {vg.name}
                    </button>
                  </div>
                  {isVideoFolderCollapsed ? null : orderedGroupFiles.length === 0 ? (
                    <p className="pl-14 pr-3 pb-2 text-xs text-muted-foreground/70 italic">Video is not approved.</p>
                  ) : (
                    orderedGroupFiles.map((file) => {
                      const fileKey = getDownloadableFileKey(file)
                      const isChecked = selectedFileIdsValue.has(fileKey)
                      const FileIcon = getFileIcon(file)
                      const isSubFile = file.type !== 'video'
                      const isImageAsset = file.type === 'asset' && getDownloadableFileKind(file) === 'image'
                      const canCheckFile = isSelectableDownloadableFile(file)
                      const fileDisplayName = file.type === 'video'
                        ? `${vg.name} - ${file.versionLabel || file.fileName}`
                        : file.fileName
                      return (
                        <div
                          key={fileKey}
                          className={cn(
                            'flex items-center gap-2 py-0.5 pr-3 hover:bg-accent transition-colors',
                            isSubFile && dlGroup?.groupType === 'video' ? 'pl-14' : 'pl-12'
                          )}
                          onClick={() => {
                            if (file.type === 'video') {
                              openVideoVersionInView(file)
                              return
                            }
                            if (!isImageAsset) return

                            onVideoSelect(vg.name)
                            setDesktopActiveTabValue('files')
                            window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                              detail: { folderName: vg.name, fileKey },
                            }))
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              file,
                              imageList: orderedGroupFiles,
                              openFolder: { name: vg.name, groupType: 'video' },
                            })
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!canCheckFile}
                            onChange={() => {
                              if (!canCheckFile) return
                              setSelectedFileIdsValue((prev) => {
                                const next = new Set(prev)
                                if (next.has(fileKey)) next.delete(fileKey)
                                else next.add(fileKey)
                                return next
                              })
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className={cn(
                              SIDEBAR_CHECKBOX_CLASS,
                              canCheckFile ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                            )}
                          />
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span
                            className={cn(
                              'flex-1 text-[13px] text-muted-foreground truncate py-0.5',
                              file.type === 'video' || isImageAsset ? 'cursor-pointer hover:text-foreground' : 'cursor-default'
                            )}
                            title={fileDisplayName}
                          >
                            {fileDisplayName}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              )
            })}

            {!isProjectRootCollapsed && hasAlbums && albumsList.map((a) => {
              const dlGroup = downloadableFiles?.find((g) => g.name === a.name && g.groupType === 'album') ?? null
              const groupFiles: DownloadableFile[] = dlGroup
                ? [...(dlGroup.mainFile ? [dlGroup.mainFile] : []), ...dlGroup.subFiles]
                : []
              const sortedGroupFiles = [...groupFiles].sort(compareAlbumFilesForSidebar)
              const isActiveFolder = activeFilesFolderName === a.name
              const groupFileKeys = sortedGroupFiles.map((f) => getDownloadableFileKey(f))
              const allGroupSelected = groupFileKeys.length > 0 && groupFileKeys.every((k) => selectedFileIdsValue.has(k))
              const someGroupSelected = groupFileKeys.some((k) => selectedFileIdsValue.has(k))
              const albumFolderKey = `files:album:${a.id}`
              const isAlbumFolderCollapsed = isFolderCollapsed(albumFolderKey)
              const openMainFilesFolder = () => {
                onAlbumSelect?.(a.id)
                window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                  detail: { folderName: a.name },
                }))
              }
              return (
                <div key={a.id}>
                  <div
                    className={cn('flex items-center gap-2 pl-6 pr-3 pt-2 pb-1', isActiveFolder && 'rounded-md bg-primary/15')}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      if (!dlGroup) return
                      setContextMenu({ x: e.clientX, y: e.clientY, group: dlGroup, openFolder: { name: a.name, groupType: 'album' } })
                    }}
                  >
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={isAlbumFolderCollapsed ? `Expand ${a.name}` : `Collapse ${a.name}`}
                      onClick={() => toggleFolderCollapsed(albumFolderKey)}
                    >
                      {isAlbumFolderCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                    <input
                      type="checkbox"
                      checked={allGroupSelected}
                      disabled={groupFileKeys.length === 0}
                      ref={(el) => { if (el) el.indeterminate = someGroupSelected && !allGroupSelected }}
                      onChange={() => {
                        setSelectedFileIdsValue((prev) => {
                          const next = new Set(prev)
                          if (allGroupSelected) {
                            groupFileKeys.forEach((k) => next.delete(k))
                          } else {
                            groupFileKeys.forEach((k) => next.add(k))
                          }
                          return next
                        })
                      }}
                      className={cn(
                        SIDEBAR_CHECKBOX_CLASS,
                        groupFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                    />
                    <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                    <button
                      type="button"
                      className="text-sm font-semibold text-foreground truncate text-left hover:underline"
                      onClick={openMainFilesFolder}
                      title={`Open ${a.name} in Files`}
                    >
                      {a.name}
                    </button>
                  </div>
                  {isAlbumFolderCollapsed ? null : sortedGroupFiles.length === 0 ? (
                    <p className="pl-14 pr-3 pb-2 text-xs text-muted-foreground/70 italic">No files available.</p>
                  ) : (
                    sortedGroupFiles.map((file) => {
                      const fileKey = getDownloadableFileKey(file)
                      const isChecked = selectedFileIdsValue.has(fileKey)
                      const FileIcon = getFileIcon(file)
                      const isAlbumPhoto = file.type === 'album-photo'
                      return (
                        <div
                          key={fileKey}
                          className={cn(
                            'flex items-center gap-2 py-0.5 pr-3 hover:bg-accent transition-colors',
                            isAlbumPhoto ? 'pl-14' : 'pl-12'
                          )}
                          onClick={() => {
                            if (!isAlbumPhoto) return
                            onAlbumSelect?.(a.id)
                            setDesktopActiveTabValue('files')
                            window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                              detail: { folderName: a.name, fileKey },
                            }))
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              file,
                              imageList: sortedGroupFiles,
                              openFolder: { name: a.name, groupType: 'album' },
                            })
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setSelectedFileIdsValue((prev) => {
                                const next = new Set(prev)
                                if (next.has(fileKey)) next.delete(fileKey)
                                else next.add(fileKey)
                                return next
                              })
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className={cn(SIDEBAR_CHECKBOX_CLASS, 'cursor-pointer')}
                          />
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span
                            className={cn('flex-1 text-[13px] text-muted-foreground truncate py-0.5', isAlbumPhoto ? 'cursor-pointer hover:text-foreground' : 'cursor-default')}
                            title={file.fileName}
                          >
                            {file.fileName}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              )
            })}

            {hasUploads ? (
              <div>
                <div
                  className={cn('flex items-center gap-2 px-3 pt-2 pb-1', isUploadsRootActive && 'rounded-md bg-primary/15')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (!uploadRootGroup) return
                    setContextMenu({ x: e.clientX, y: e.clientY, group: uploadRootGroup, openFolder: { name: 'UPLOADS', groupType: 'uploads' } })
                  }}
                >
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={isUploadsRootCollapsed ? 'Expand UPLOADS' : 'Collapse UPLOADS'}
                    onClick={() => toggleFolderCollapsed(uploadsRootFolderKey)}
                  >
                    {isUploadsRootCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                  <input
                    type="checkbox"
                    checked={allUploadsSelected}
                    disabled={uploadRootFileKeys.length === 0}
                    ref={(el) => { if (el) el.indeterminate = someUploadsSelected && !allUploadsSelected }}
                    onChange={() => {
                      setSelectedFileIdsValue((prev) => {
                        const next = new Set(prev)
                        if (allUploadsSelected) {
                          uploadRootFileKeys.forEach((key) => next.delete(key))
                        } else {
                          uploadRootFileKeys.forEach((key) => next.add(key))
                        }
                        return next
                      })
                    }}
                    className={cn(
                      SIDEBAR_CHECKBOX_CLASS,
                      uploadRootFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                    )}
                    aria-label="Select all files in UPLOADS"
                  />
                  <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                  <button
                    type="button"
                    className={cn(
                      'text-sm font-semibold truncate text-left hover:underline',
                      isUploadsRootActive ? 'text-primary' : 'text-foreground'
                    )}
                    onClick={() => {
                      setDesktopActiveTabValue('files')
                      window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                        detail: { folderName: 'UPLOADS' },
                      }))
                    }}
                    title="Open UPLOADS in Files"
                  >
                    UPLOADS
                  </button>
                </div>

                {!isUploadsRootCollapsed && uploadRootGroup && uploadRootGroup.subFiles.length === 0 && nestedUploadGroups.length === 0 ? (
                  <p className="pl-14 pr-3 pb-2 text-xs text-muted-foreground/70 italic">No files available.</p>
                ) : null}

                {!isUploadsRootCollapsed && sortedUploadRootFiles.map((file) => {
                  const fileKey = getDownloadableFileKey(file)
                  const isChecked = selectedFileIdsValue.has(fileKey)
                  const FileIcon = getFileIcon(file)

                  return (
                    <div
                      key={fileKey}
                      className="flex items-center gap-2 py-0.5 pr-3 hover:bg-accent transition-colors pl-12"
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setContextMenu({
                          x: e.clientX,
                          y: e.clientY,
                          file,
                          imageList: sortedUploadRootFiles,
                          openFolder: { name: 'UPLOADS', groupType: 'uploads' },
                        })
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          setSelectedFileIdsValue((prev) => {
                            const next = new Set(prev)
                            if (next.has(fileKey)) next.delete(fileKey)
                            else next.add(fileKey)
                            return next
                          })
                        }}
                        onClick={(event) => event.stopPropagation()}
                        className={cn(SIDEBAR_CHECKBOX_CLASS, 'cursor-pointer')}
                      />
                      <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 text-[13px] text-muted-foreground truncate py-0.5" title={file.fileName}>
                        {file.fileName}
                      </span>
                    </div>
                  )
                })}

                {!isUploadsRootCollapsed && nestedUploadGroups.map((group) => {
                  const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
                  const sortedGroupFiles = [...groupFiles].sort(compareFileNameAsc)
                  const isActiveFolder = activeFilesFolderName === group.name
                  const groupFileKeys = sortedGroupFiles.map((f) => getDownloadableFileKey(f))
                  const allGroupSelected = groupFileKeys.length > 0 && groupFileKeys.every((k) => selectedFileIdsValue.has(k))
                  const someGroupSelected = groupFileKeys.some((k) => selectedFileIdsValue.has(k))
                  const folderLabel = getUploadsRelativePath(group.name)
                  const nestedUploadsFolderKey = `files:uploads:${group.name}`
                  const isNestedUploadsFolderCollapsed = isFolderCollapsed(nestedUploadsFolderKey)
                  const openMainFilesFolder = () => {
                    setDesktopActiveTabValue('files')
                    window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                      detail: { folderName: group.name },
                    }))
                  }

                  return (
                    <div key={`uploads-${group.name}`}>
                      <div
                        className={cn('flex items-center gap-2 pl-12 pr-3 pt-2 pb-1', isActiveFolder && 'rounded-md bg-primary/15')}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setContextMenu({ x: e.clientX, y: e.clientY, group, openFolder: { name: group.name, groupType: 'uploads' } })
                        }}
                      >
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={isNestedUploadsFolderCollapsed ? `Expand ${folderLabel}` : `Collapse ${folderLabel}`}
                          onClick={() => toggleFolderCollapsed(nestedUploadsFolderKey)}
                        >
                          {isNestedUploadsFolderCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        <input
                          type="checkbox"
                          checked={allGroupSelected}
                          disabled={groupFileKeys.length === 0}
                          ref={(el) => { if (el) el.indeterminate = someGroupSelected && !allGroupSelected }}
                          onChange={() => {
                            setSelectedFileIdsValue((prev) => {
                              const next = new Set(prev)
                              if (allGroupSelected) {
                                groupFileKeys.forEach((k) => next.delete(k))
                              } else {
                                groupFileKeys.forEach((k) => next.add(k))
                              }
                              return next
                            })
                          }}
                          className={cn(
                            SIDEBAR_CHECKBOX_CLASS,
                            groupFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                          )}
                        />
                        <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                        <button
                          type="button"
                          className="text-sm font-semibold text-foreground truncate text-left hover:underline"
                          onClick={openMainFilesFolder}
                          title={`Open ${folderLabel} in Files`}
                        >
                          {folderLabel}
                        </button>
                      </div>
                      {isNestedUploadsFolderCollapsed ? null : sortedGroupFiles.length === 0 ? (
                        <p className="pl-16 pr-3 pb-2 text-xs text-muted-foreground/70 italic">No files available.</p>
                      ) : (
                        sortedGroupFiles.map((file) => {
                          const fileKey = getDownloadableFileKey(file)
                          const isChecked = selectedFileIdsValue.has(fileKey)
                          const FileIcon = getFileIcon(file)

                          return (
                            <div
                              key={fileKey}
                              className="flex items-center gap-2 py-0.5 pr-3 hover:bg-accent transition-colors pl-16"
                              onContextMenu={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  file,
                                  imageList: sortedGroupFiles,
                                  openFolder: { name: group.name, groupType: 'uploads' },
                                })
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => {
                                  setSelectedFileIdsValue((prev) => {
                                    const next = new Set(prev)
                                    if (next.has(fileKey)) next.delete(fileKey)
                                    else next.add(fileKey)
                                    return next
                                  })
                                }}
                                onClick={(event) => event.stopPropagation()}
                                className={cn(SIDEBAR_CHECKBOX_CLASS, 'cursor-pointer')}
                              />
                              <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="flex-1 text-[13px] text-muted-foreground truncate py-0.5" title={file.fileName}>
                                {file.fileName}
                              </span>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {downloadableFiles && downloadableFiles.length > 0 && (onDownloadFile || onDownloadFiles) && (
        <div className={cn('flex-shrink-0 border-t border-border bg-card p-2 space-y-1.5', isMobile && 'sticky bottom-0')}>
          {/* Progress bar above buttons */}
          {showDownloadProgress && (
            <div className="w-full mb-2">
              <div className="h-2 bg-muted rounded overflow-hidden">
                <div
                  className="bg-primary transition-all h-2"
                  style={{ width: `${effectiveProgressPercent}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(effectiveProgressPercent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <div className="text-xs text-muted-foreground mt-1 text-center">Downloading… {Math.round(effectiveProgressPercent)}%</div>
            </div>
          )}

          <div className="flex gap-1">
            <button
              type="button"
              onClick={handleSelectAll}
              className="flex-1 py-1 text-xs font-semibold uppercase tracking-wider border border-border rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              Select All
            </button>
            <button
              type="button"
              onClick={handleClearSelected}
              className="flex-1 py-1 text-xs font-semibold uppercase tracking-wider border border-border rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              Clear Selected
            </button>
          </div>
          <button
            type="button"
            onClick={selectedFileIdsValue.size > 0 ? handleDownloadSelected : undefined}
            disabled={isDownloadingAll || selectedFileIdsValue.size === 0}
            className={cn(
              'w-full py-2 text-xs font-bold uppercase tracking-widest rounded transition-colors',
              selectedFileIdsValue.size > 0 && !isDownloadingAll
                ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                : 'bg-muted text-muted-foreground opacity-50 cursor-not-allowed'
            )}
          >
            {isDownloadingAll
              ? effectiveDownloadProgress !== null
                ? `Downloading… ${Math.round(effectiveProgressPercent)}%`
                : 'Preparing…'
              : selectedFileIdsValue.size > 0
              ? `Download (${selectedFileIdsValue.size})`
              : 'Download'}
          </button>
        </div>
      )}
    </div>
    )
  }

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        ref={sidebarRef}
        style={{ width: `${sidebarWidth}px` }}
        className={cn(
          'bg-card border border-border relative rounded-lg',
          'overflow-hidden min-h-0',
          // Default to full viewport height (minus admin header). Callers can override via className.
          'h-[calc(100dvh-var(--admin-header-height,0px))]',
          className,
          // Enforce desktop-only visibility regardless of caller classes.
          'hidden lg:flex lg:flex-col'
        )}
      >
        {hasLogo && (
          <div className="p-4 border-b border-border flex-shrink-0">
            {mainCompanyDomain ? (
              <a href={mainCompanyDomain} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={logoSrc}
                  alt="Company logo"
                  className="w-full max-h-16 h-auto object-contain"
                />
              </a>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt="Company logo"
                className="w-full max-h-16 h-auto object-contain"
              />
            )}
          </div>
        )}
        {heading && (
          <div className="p-4 border-b border-border space-y-3 flex-shrink-0">
            {showProjectHeadingLabel && (
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Project:
              </div>
            )}
            <h2 className="text-base font-semibold text-foreground truncate" title={heading}>
              {heading}
            </h2>
            {canOpenProjectSwitcher && (
              <button
                type="button"
                onClick={onProjectSwitcherOpen}
                className="w-full rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground uppercase tracking-wider transition-colors hover:bg-primary/90"
              >
                Change Project
              </button>
            )}
          </div>
        )}

        <div ref={splitContainerRef} className="flex flex-col flex-1 min-h-0">
          {hideApprovalGrouping ? (
            /* ── GUEST / PUBLIC: flat list + split FILES section ── */
            <>
              <div
                className="flex flex-col"
                style={{ height: showBottomSection ? `${(1 - filesRatio) * 100}%` : '100%' }}
              >
                <div className="overflow-y-auto overflow-x-hidden flex-1 mr-[5px]">
                  <nav className="p-3">
                    {flatAlphabeticalGroups.length > 0 && (
                      <>
                        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                          <Play className="w-3 h-3" />
                          Videos
                        </div>
                        <div className="space-y-1 mb-4">
                          {flatAlphabeticalGroups.map(g => renderVideoButton(g))}
                        </div>
                      </>
                    )}
                    {shouldShowAlbums && (
                      <>
                        <div className="border-t border-border my-3" />
                        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                          <Images className="w-3 h-3" />
                          Albums
                        </div>
                        <div className="space-y-1">
                          {albumsList.map(a => renderAlbumButton(a))}
                        </div>
                      </>
                    )}
                  </nav>
                </div>
              </div>

              {showBottomSection && (
                <>
                  <div
                    className="flex-shrink-0 h-[5px] bg-border hover:bg-primary/20 cursor-row-resize flex items-center justify-center group transition-colors"
                    onMouseDown={(e) => { e.preventDefault(); setIsDraggingDivider(true) }}
                  >
                    <div className="w-8 h-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-primary/50 transition-colors" />
                  </div>
                  <div
                    className="flex flex-col"
                    style={{ height: `${filesRatio * 100}%` }}
                  >
                    <div className="flex-shrink-0 bg-card px-3 py-2 flex items-center justify-between border-b border-border">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Files</span>
                      {downloadableFiles && downloadableFiles.length > 0 && (onDownloadFile || onDownloadFiles) && (
                        <button
                          onClick={handleDownloadAll}
                          disabled={isDownloadingAll}
                          className="text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          {isDownloadingAll ? 'Downloading...' : 'Download All'}
                        </button>
                      )}
                    </div>
                    <div className="overflow-y-auto overflow-x-hidden flex-1 mr-[5px]">
                      {downloadableFiles && downloadableFiles.length === 0 && (
                        <p className="px-3 py-4 text-xs text-muted-foreground">
                          {hasApprovableVideos
                            ? 'No videos have been approved for download'
                            : 'No content currently available for download'}
                        </p>
                      )}
                      {downloadableFiles && downloadableFiles.length > 0 && (
                        <div className="py-2">
                          {downloadableFiles.map((group) => (
                            <div key={group.name}>
                              <div className="px-3 pt-2 pb-0.5 text-xs font-semibold text-foreground">{group.name}</div>
                              {group.mainFile && (
                                <button
                                  onClick={() => void onDownloadFile?.(group.mainFile!)}
                                  className="w-full text-left px-3 py-1 text-xs text-muted-foreground hover:bg-accent truncate block transition-colors"
                                  title={group.mainFile.fileName}
                                >
                                  {group.mainFile.fileName}
                                </button>
                              )}
                              {group.subFiles.map((file) => (
                                <button
                                  key={getDownloadableFileKey(file)}
                                  onClick={() => void onDownloadFile?.(file)}
                                  className={cn(
                                    'w-full text-left py-1 text-xs text-muted-foreground hover:bg-accent truncate block transition-colors',
                                    group.groupType === 'video' ? 'pl-6 pr-3' : 'px-3'
                                  )}
                                  title={file.fileName}
                                >
                                  {group.groupType === 'video' ? `- ${file.fileName}` : file.fileName}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            /* ── ADMIN / REVIEW: tab-based layout ── */
            <>
              {/* Optional tab bar — can be moved to page header via controlled props */}
              {showDesktopTabBar && (
                <div className="flex flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setDesktopActiveTabValue('for-review')}
                    className={cn(
                      'flex-1 py-3 text-xs font-bold uppercase tracking-widest transition-colors',
                      desktopActiveTabValue === 'for-review'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={() => setDesktopActiveTabValue('files')}
                    className={cn(
                      'flex-1 py-3 text-xs font-bold uppercase tracking-widest transition-colors border-l border-border/50',
                      desktopActiveTabValue === 'files'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    Files
                  </button>
                </div>
              )}

              {/* FOR REVIEW tab */}
              {desktopActiveTabValue === 'for-review' && (
                <div className="overflow-y-auto overflow-x-hidden flex-1 min-h-0 mr-[5px]">
                  <nav className="p-3">
                    {/* For Review heading */}
                    {forReviewGroups.length > 0 && (
                      <div className="px-3 py-2 text-xs font-semibold text-warning uppercase tracking-wider flex items-center gap-2">
                        <Play className="w-3 h-3" />
                        For Review
                      </div>
                    )}
                    {forReviewGroups.length > 0 && (
                      <div className="space-y-1">
                        {forReviewGroups.map(g => renderVideoButton(g))}
                      </div>
                    )}

                    {/* APPROVED section */}
                    {approvedGroups.length > 0 && (
                      <div className={cn(forReviewGroups.length > 0 ? 'mt-4' : '')}>
                        <div
                          className={cn(
                            'px-3 py-2 text-xs font-semibold text-success uppercase tracking-wider flex items-center gap-2',
                            forReviewGroups.length > 0 ? 'border-t border-border pt-3' : ''
                          )}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Approved
                        </div>
                        <div className="space-y-1">
                          {approvedGroups.map(g => renderVideoButton(g))}
                        </div>
                      </div>
                    )}

                    {/* ALBUMS section */}
                    {hasAlbums && (
                      <div className="mt-4">
                        <div className="px-3 py-2 text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-2 border-t border-border pt-3">
                          <Images className="w-3 h-3" />
                          Albums
                        </div>
                        <div className="space-y-1">
                          {albumsList.map(a => renderAlbumButton(a))}
                        </div>
                      </div>
                    )}

                    {/* UPLOADS folder (combined files view) */}
                    {showUploadsInView && renderUploadsViewButton()}
                  </nav>
                </div>
              )}

              {/* FILES tab */}
              {desktopActiveTabValue === 'files' && renderFilesTabSection(false)}

              {/* Right-click context menu for FILES mode */}
              {desktopActiveTabValue === 'files' && contextMenu
                ? createPortal(
                    <div
                      ref={contextMenuRef}
                      className="fixed z-[9999] min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-elevation-lg text-popover-foreground"
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
                        canSelectFile={contextMenu.file ? isSelectableDownloadableFile(contextMenu.file) : false}
                        isSelected={contextMenu.file ? selectedFileIdsValue.has(getDownloadableFileKey(contextMenu.file)) : false}
                        isGroupSelected={
                          contextMenu.group
                            ? (() => {
                                const files = [...(contextMenu.group.mainFile ? [contextMenu.group.mainFile] : []), ...contextMenu.group.subFiles]
                                  .filter((f) => isSelectableDownloadableFile(f))
                                return files.length > 0 && files.every((f) => selectedFileIdsValue.has(getDownloadableFileKey(f)))
                              })()
                            : false
                        }
                        canDownloadFile={contextMenu.file ? (contextMenu.file.type !== 'video' || contextMenu.file.isApproved !== false) : false}
                        showApproveButton={contextMenu.file ? (
                          contextMenu.file.type === 'video' &&
                          contextMenu.file.isApproved === false &&
                          contextMenu.file.allowApproval === true &&
                          !!onApproveVideo &&
                          // Don't allow approving another version if one is already approved.
                          !((() => {
                            const groupName = contextMenu.openFolder?.name
                            if (!groupName) return false
                            const group = (downloadableFiles ?? []).find(
                              (g) => g.name === groupName && g.groupType === 'video'
                            )
                            if (!group) return false
                            return [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
                              .some((f) => f.type === 'video' && f.isApproved === true)
                          })())
                        ) : false}
                        fileKind={contextMenu.file ? getDownloadableFileKind(contextMenu.file) : null}
                        isVideoAssetFile={contextMenu.file ? (getDownloadableFileKind(contextMenu.file) === 'video' && contextMenu.file.type !== 'video') : false}
                        openFolder={contextMenu.openFolder ?? null}
                        onPlay={() => {
                          if (contextMenu.file && onOpenVideoVersion) {
                            onOpenVideoVersion(contextMenu.file, contextMenu.openFolder?.name || null)
                          }
                        }}
                        onOpenLightbox={() => {
                          if (!contextMenu.file || !contextMenu.imageList) return
                          const kind = getDownloadableFileKind(contextMenu.file)
                          if (kind === 'image' || kind === 'video' || kind === 'audio') {
                            // Navigate the main files area to the parent folder, then open the lightbox.
                            const folderName = contextMenu.openFolder?.name
                            if (!folderName) return
                            setDesktopActiveTabValue('files')
                            if (contextMenu.openFolder?.groupType === 'video') {
                              onVideoSelect(folderName)
                            }
                            window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                              detail: {
                                folderName,
                                fileKey: getDownloadableFileKey(contextMenu.file),
                              },
                            }))
                          }
                        }}
                        onOpenFolder={() => {
                          if (!contextMenu.group || !contextMenu.openFolder) return
                          setDesktopActiveTabValue('files')
                          if (contextMenu.openFolder.groupType === 'video') {
                            onVideoSelect(contextMenu.openFolder.name)
                          } else if (contextMenu.openFolder.groupType === 'album') {
                            onAlbumSelect?.(contextMenu.group.subFiles.find((f) => f.albumId)?.albumId || '')
                          }
                          window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                            detail: { folderName: contextMenu.openFolder.name },
                          }))
                        }}
                        onSelect={() => {
                          if (!contextMenu.file) return
                          const key = getDownloadableFileKey(contextMenu.file)
                          setSelectedFileIdsValue((prev) => {
                            const next = new Set(prev)
                            if (next.has(key)) next.delete(key)
                            else next.add(key)
                            return next
                          })
                        }}
                        onSelectFolder={() => {
                          if (!contextMenu.group || !contextMenu.openFolder) return
                          // For upload folders, also collect files from nested subfolders.
                          let groups: DownloadableGroup[]
                          if (contextMenu.openFolder.groupType === 'uploads') {
                            const prefix = contextMenu.openFolder.name
                            groups = (downloadableFiles ?? []).filter(
                              (g) => g.groupType === 'uploads' && (g.name === prefix || g.name.startsWith(prefix + ' / '))
                            )
                          } else {
                            groups = [contextMenu.group]
                          }
                          const files = groups
                            .flatMap((g) => [...(g.mainFile ? [g.mainFile] : []), ...g.subFiles])
                            .filter((f) => isSelectableDownloadableFile(f))
                          const allKeys = files.map((f) => getDownloadableFileKey(f))
                          const allSelected = allKeys.length > 0 && allKeys.every((k) => selectedFileIdsValue.has(k))
                          setSelectedFileIdsValue((prev) => {
                            const next = new Set(prev)
                            if (allSelected) {
                              allKeys.forEach((k) => next.delete(k))
                            } else {
                              allKeys.forEach((k) => next.add(k))
                            }
                            return next
                          })
                        }}
                        onDownload={() => {
                          if (contextMenu.file && onDownloadFile) void onDownloadFile(contextMenu.file)
                        }}
                        onDownloadFolder={() => {
                          if (!contextMenu.group) return
                          const files = [...(contextMenu.group.mainFile ? [contextMenu.group.mainFile] : []), ...contextMenu.group.subFiles]
                            .filter((f) => isSelectableDownloadableFile(f))
                          if (files.length > 0) {
                            if (onDownloadFiles) {
                              void onDownloadFiles(files)
                            } else if (onDownloadFile) {
                              void Promise.all(files.map((f) => onDownloadFile!(f).catch(() => undefined)))
                            }
                          }
                        }}
                        onApprove={() => {
                          if (contextMenu.file && onApproveVideo) {
                            void onApproveVideo(contextMenu.file)
                          }
                        }}
                        onRenameFolder={() => {
                          if (!contextMenu.group || !onRenameUploadFolder) return
                          const path = getUploadsRelativePath(contextMenu.group.name)
                          const label = path.split('/').pop()?.trim() || contextMenu.group.name
                          setRenameFolderTarget({ path, currentName: label })
                        }}
                        onDeleteFolder={() => {
                          if (!contextMenu.group || !onDeleteUploadFolder) return
                          const path = getUploadsRelativePath(contextMenu.group.name)
                          const label = path.split('/').pop()?.trim() || contextMenu.group.name
                          setDeleteFolderTarget({ path, label })
                        }}
                        onDeleteFile={() => {
                          if (contextMenu.file?.uploadFileId && onDeleteUploadFile) {
                            setDeleteFileTarget({ fileId: contextMenu.file.uploadFileId, fileName: contextMenu.file.fileName })
                          }
                        }}
                        canUploadAdmin={canDeleteUploads}
                        onOpenAlbumPhoto={() => {
                          if (contextMenu.file && contextMenu.imageList) {
                            // Navigate the main files area to the album folder, then open the album viewer.
                            const folderName = contextMenu.openFolder?.name
                            if (!folderName) return
                            setDesktopActiveTabValue('files')
                            if (contextMenu.openFolder?.groupType === 'album') {
                              onAlbumSelect?.(contextMenu.file.albumId || '')
                            }
                            window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                              detail: {
                                folderName,
                                fileKey: getDownloadableFileKey(contextMenu.file),
                              },
                            }))
                          }
                        }}
                        albumPhotoSocialDownloadUrl={
                          contextMenu.file?.photoId && contextMenu.file?.albumId ? (
                            (() => {
                              const socialEnabled = (albumSocialEnabledByAlbumId[contextMenu.file.albumId!] ?? albumSocialEnabledByAlbumIdInternal[contextMenu.file.albumId!]) !== false
                              const meta = albumPhotoMetaByPhotoId[contextMenu.file.photoId!] ?? albumPhotoMetaByPhotoIdInternal[contextMenu.file.photoId!]
                              return socialEnabled && meta?.socialDownloadUrl && meta?.socialReady ? meta.socialDownloadUrl : null
                            })()
                          ) : null
                        }
                        onDownloadSocial={() => {
                          if (contextMenu.file?.photoId && contextMenu.file?.albumId) {
                            const meta = albumPhotoMetaByPhotoId[contextMenu.file.photoId] ?? albumPhotoMetaByPhotoIdInternal[contextMenu.file.photoId]
                            if (meta?.socialDownloadUrl) {
                              const link = document.createElement('a')
                              link.href = meta.socialDownloadUrl
                              link.rel = 'noopener'
                              link.download = ''
                              link.style.display = 'none'
                              document.body.appendChild(link)
                              link.click()
                              link.remove()
                            }
                          }
                        }}
                        groupHasApprovedVersion={
                          contextMenu.file?.type === 'video'
                            ? ((() => {
                                const groupName = contextMenu.openFolder?.name
                                if (!groupName) return false
                                const group = (downloadableFiles ?? []).find(
                                  (g) => g.name === groupName && g.groupType === 'video'
                                )
                                if (!group) return false
                                return [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
                                  .some((f) => f.type === 'video' && f.isApproved === true)
                              })())
                            : false
                        }
                      />
                    </div>,
                    document.body,
                  )
                : null}
            </>
          )}
        </div>

        {renderTransfersSection(false)}

        {/* Resize Handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-[5px] z-20 bg-transparent hover:bg-primary/15 cursor-col-resize flex items-center justify-center group transition-colors"
        >
          <div className="h-8 w-0.5 rounded-full bg-primary/45 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </aside>

      {/* Mobile Horizontal Scrollable Row */}
      <div ref={mobileContainerRef} className="lg:hidden sticky top-0 z-30 bg-card border-y border-border">
          {/* Always-visible heading row — outside overflow-hidden so it is never clipped by the scrollbar */}
          <div className="px-4 py-2 flex items-center justify-between bg-accent/30">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {isMobileFilesMode
                  ? 'Files'
                  : hasVideos && hasAlbums
                  ? 'Videos & Albums'
                  : hasVideos
                  ? 'Videos'
                  : hasAlbums
                  ? 'Albums'
                  : 'No Content Ready'}
              </span>
              <button
                type="button"
                onClick={() => setIsMobileCollapsed((prev) => !prev)}
                className="flex items-center justify-center w-5 h-5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                aria-label={
                  isMobileCollapsed
                    ? isMobileFilesMode
                      ? 'Show files selector'
                      : 'Show video selector'
                    : isMobileFilesMode
                    ? 'Hide files selector'
                    : 'Hide video selector'
                }
              >
                {isMobileCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* X of Y counter with prev/next arrows */}
            {!isMobileFilesMode && (() => {
              const sortedGroups = sortedVideoGroups(videoGroups)
              const allItems: Array<{ type: 'video'; name: string } | { type: 'album'; id: string; name: string }> = []
              if (shouldShowVideos) {
                sortedGroups.forEach((g) => allItems.push({ type: 'video', name: g.name }))
              }
              if (shouldShowAlbums) {
                albumsList.forEach((a) => allItems.push({ type: 'album', id: a.id, name: a.name }))
              }
              if (allItems.length <= 1) return null

              const currentIndex = allItems.findIndex((item) =>
                item.type === 'video'
                  ? (!activeAlbumId && activeVideoName === item.name)
                  : (activeAlbumId === (item as any).id)
              )
              const displayIndex = currentIndex >= 0 ? currentIndex + 1 : 1

              const goPrev = () => {
                const prevIdx = (currentIndex - 1 + allItems.length) % allItems.length
                const prev = allItems[prevIdx]
                if (prev.type === 'video') onVideoSelect(prev.name)
                else onAlbumSelect?.((prev as any).id)
              }
              const goNext = () => {
                const nextIdx = (currentIndex + 1) % allItems.length
                const next = allItems[nextIdx]
                if (next.type === 'video') onVideoSelect(next.name)
                else onAlbumSelect?.((next as any).id)
              }

              return (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={goPrev}
                    className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Previous"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {displayIndex} of {allItems.length}
                  </span>
                  <button
                    type="button"
                    onClick={goNext}
                    className="flex items-center justify-center w-5 h-5 rounded text-muted-foreground hover:text-foreground transition-colors"
                    aria-label="Next"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })()}

            {isMobileFilesMode && selectedFileIdsValue.size > 0 ? (
              <span className="text-xs text-muted-foreground text-right tabular-nums whitespace-nowrap ml-2">
                {selectedFileIdsValue.size} file{selectedFileIdsValue.size === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedFilesTotalSizeBytes)}
              </span>
            ) : null}
          </div>

          {/* Collapsible thumbnails area */}
          <div className={cn(
            'overflow-hidden transition-all duration-200 border-t border-border',
            isMobileCollapsed ? 'max-h-0 opacity-0' : 'max-h-[800px] opacity-100'
          )}>
            {heading && showProjectHeadingLabel && (
              <div className="px-4 pt-4 pb-3 space-y-3 border-b border-border">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Project:
                </div>
                <h2 className="text-base font-semibold text-foreground break-words">
                  {heading}
                </h2>
                {canOpenProjectSwitcher && (
                  <button
                    type="button"
                    onClick={onProjectSwitcherOpen}
                    className="w-full rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground uppercase tracking-wider transition-colors hover:bg-primary/90"
                  >
                    Change Project
                  </button>
                )}
              </div>
            )}
            {isMobileFilesMode ? (
              <div className="max-h-[320px] overflow-y-auto border-t border-border">
                {renderFilesTabSection(true)}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="flex gap-3 p-3">
              {/* Videos */}
              {shouldShowVideos && sortedVideoGroups(videoGroups).map((group) => {
                const isActive = !activeAlbumId && activeVideoName === group.name
                const latestVideo = group.videos[0]
                const approvedVideo = group.videos.find((v: any) => v.approved === true)
                const displayVideo = approvedVideo || latestVideo
                const thumbnailUrl = displayVideo?.thumbnailUrl
                const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
                const mobileThumbSize = 100
                const mobileThumbHeight = Math.round(mobileThumbSize * 9 / 16)
                const latestVideoDims = calculateThumbnailDimensions(
                  displayVideo?.width || displayVideo?.videoWidth,
                  displayVideo?.height || displayVideo?.videoHeight,
                  mobileThumbSize,
                  mobileThumbHeight
                )

                return (
                  <button
                    key={group.name}
                    onClick={() => onVideoSelect(group.name)}
                    className={cn(
                      'flex flex-col gap-2 flex-shrink-0 transition-all duration-200',
                      'rounded-lg p-2',
                      isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-accent'
                    )}
                  >
                    {/* Thumbnail */}
                    {thumbnailUrl && latestVideoDims && (
                      <div
                        className="bg-black rounded overflow-hidden flex items-center justify-center relative"
                        style={{
                          width: mobileThumbSize,
                          height: mobileThumbHeight,
                        }}
                      >
                        <div
                          className="relative"
                          style={{
                            width: latestVideoDims.width,
                            height: latestVideoDims.height,
                          }}
                        >
                          <Image
                            src={thumbnailUrl}
                            alt={group.name}
                            fill
                            className="object-contain"
                            unoptimized
                            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.visibility = 'hidden' }}
                          />
                        </div>

                        {hasApprovedVideo && (
                          <div className="absolute bottom-1 right-1 h-6 w-6 rounded-full bg-success flex items-center justify-center shadow">
                            <Check className="h-4 w-4 text-white" />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Title and version count */}
                    <div className="flex flex-col gap-1 items-center">
                      <p className="text-xs font-medium text-foreground line-clamp-2 break-words max-w-[90px] text-center leading-snug">
                        {group.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {hideApprovalGrouping && group.videos[0]?.versionLabel
                          ? group.videos[0].versionLabel
                          : `${group.versionCount} ${group.versionCount === 1 ? 'version' : 'versions'}`}
                      </p>
                    </div>
                  </button>
                )
              })}

              {/* Albums */}
              {shouldShowAlbums && albumsList.map((a) => {
                const isActive = activeAlbumId === a.id
                const previewUrl = (a as any)?.thumbnailPhotoUrl as string | null | undefined
                const mobileThumbSize = 100
                const mobileThumbHeight = Math.round(mobileThumbSize * 9 / 16)

                return (
                  <button
                    key={a.id}
                    onClick={() => onAlbumSelect?.(a.id)}
                    className={cn(
                      'flex flex-col gap-2 flex-shrink-0 transition-all duration-200',
                      'rounded-lg p-2',
                      isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-accent'
                    )}
                  >
                    {previewUrl ? (
                      <div
                        className="bg-black rounded overflow-hidden relative"
                        style={{ width: mobileThumbSize, height: mobileThumbHeight }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={previewUrl}
                          alt={a.name}
                          className="w-full h-full object-cover"
                          loading={isActive ? 'eager' : 'lazy'}
                        />
                      </div>
                    ) : (
                      <div
                        className="bg-gradient-to-br from-muted to-muted-foreground rounded flex items-center justify-center"
                        style={{ width: mobileThumbSize, height: mobileThumbHeight }}
                      >
                        <Images className="w-6 h-6 text-muted-foreground" />
                      </div>
                    )}

                    {/* Title and Count */}
                    <div className="flex flex-col items-center">
                      <p className="text-xs font-medium text-foreground line-clamp-2 break-words max-w-[90px] text-center leading-snug">
                        {a.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
                      </p>
                    </div>
                  </button>
                )
              })}

              {/* Uploads (combined files view) */}
              {showUploadsInView && (downloadableFiles ?? []).some((group) => group.groupType === 'uploads') && (() => {
                const isActive = String(activeFilesFolderName || '').trim().startsWith('UPLOADS')
                return (
                  <button
                    type="button"
                    onClick={() => onUploadsSelect?.()}
                    className={cn(
                      'flex flex-col gap-2 flex-shrink-0 transition-all duration-200 w-[140px]',
                      'rounded-lg p-2',
                      isActive ? 'bg-primary/10 border border-primary/20' : 'hover:bg-accent'
                    )}
                  >
                    <FolderPreviewMosaic
                      label="UPLOADS"
                      tiles={uploadsPreviewTiles}
                      videoPoster={uploadsPreviewPoster}
                      isUploads
                      onTileError={onUploadsPreviewError}
                    />
                    <div className="flex flex-col items-center">
                      <p className="text-xs font-medium text-foreground text-center leading-snug">
                        UPLOADS
                      </p>
                    </div>
                  </button>
                )
              })()}
                </div>
              </div>
            )}
          </div>

          {renderTransfersSection(true)}
      </div>

      <AlertDialog open={showTransferCloseWarning} onOpenChange={setShowTransferCloseWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close transfers?</AlertDialogTitle>
            <AlertDialogDescription>
              Closing the Transfers panel will cancel any active transfers still managed in the app. Downloads already handed off to your browser will continue there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Transfers Open</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCloseTransfers}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel Active Transfers
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          setIsDownloadingAll(true)
          setDownloadProgress(null)
          try {
            if (onDownloadFiles) {
              await onDownloadFiles(files, (progress) => setDownloadProgress(progress))
            } else if (onDownloadFile) {
              await Promise.all(files.map((file) => onDownloadFile(file).catch(() => undefined)))
            }
          } finally {
            setIsDownloadingAll(false)
            setDownloadProgress(null)
          }
        }}
        onCancel={() => setBulkFsaUnsupportedFiles(null)}
      />

      {/* Upload rename folder dialog */}
      <InputDialog
        open={renameFolderTarget !== null}
        onOpenChange={(v) => { if (!v) setRenameFolderTarget(null) }}
        title="Rename folder"
        label={`Enter a new name for "${renameFolderTarget?.currentName || ''}"`}
        defaultValue={renameFolderTarget?.currentName || ''}
        confirmLabel="Rename"
        cancelLabel="Cancel"
        onConfirm={async (newName) => {
          if (!renameFolderTarget || !onRenameUploadFolder) return
          setIsUploadActionBusy(true)
          try {
            await onRenameUploadFolder(renameFolderTarget.path, newName)
          } finally {
            setIsUploadActionBusy(false)
            setRenameFolderTarget(null)
          }
        }}
      />

      {/* Upload delete folder dialog */}
      <ConfirmDialog
        open={deleteFolderTarget !== null}
        onOpenChange={(v) => { if (!v) setDeleteFolderTarget(null) }}
        title="Delete folder?"
        description={`This will permanently delete the folder "${deleteFolderTarget?.label || ''}" and all files inside it. This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteFolderTarget || !onDeleteUploadFolder) return
          setIsUploadActionBusy(true)
          try {
            await onDeleteUploadFolder(deleteFolderTarget.path)
          } finally {
            setIsUploadActionBusy(false)
            setDeleteFolderTarget(null)
          }
        }}
      />

      {/* Upload delete file dialog */}
      <ConfirmDialog
        open={deleteFileTarget !== null}
        onOpenChange={(v) => { if (!v) setDeleteFileTarget(null) }}
        title="Delete file?"
        description={`This will permanently delete "${deleteFileTarget?.fileName || 'this file'}". This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteFileTarget || !onDeleteUploadFile) return
          setIsUploadActionBusy(true)
          try {
            await onDeleteUploadFile(deleteFileTarget.fileId)
          } finally {
            setIsUploadActionBusy(false)
            setDeleteFileTarget(null)
          }
        }}
      />

    </>
  )
}
