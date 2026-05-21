'use client'

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
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
  Folder,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'

interface VideoGroup {
  name: string
  videos: any[]
  versionCount: number
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
  onDownloadFiles?: (files: DownloadableFile[], onProgress?: (percent: number) => void) => Promise<void>
  /** Whether the project has any videos with allowApproval=true, used for empty state messages. */
  hasApprovableVideos?: boolean
  /** Whether the desktop tab bar should be rendered inside the sidebar. */
  showDesktopTabBar?: boolean
  /** Controlled desktop mode; when omitted, sidebar manages it internally. */
  desktopActiveTab?: 'for-review' | 'files'
  /** Controlled desktop mode setter. */
  onDesktopActiveTabChange?: (tab: 'for-review' | 'files') => void
  /** Controlled selected file IDs for files mode. */
  selectedFileIds?: Set<string>
  /** Controlled selected file IDs setter. */
  onSelectedFileIdsChange?: React.Dispatch<React.SetStateAction<Set<string>>>
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
  hasApprovableVideos = false,
  showDesktopTabBar = true,
  desktopActiveTab,
  onDesktopActiveTabChange,
  selectedFileIds,
  onSelectedFileIdsChange,
}: VideoSidebarProps) {
  const logoSrc = '/api/branding/logo'
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed)
  const [isMobileCollapsed, setIsMobileCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(256) // Default 256px (w-64)
  const [isResizing, setIsResizing] = useState(false)
  const [filesRatio, setFilesRatio] = useState(0.35)
  const [hasManualRatio, setHasManualRatio] = useState(false)
  const [isDraggingDivider, setIsDraggingDivider] = useState(false)
  const [isDownloadingAll, setIsDownloadingAll] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [showLocalModeWarning, setShowLocalModeWarning] = useState(false)
  const [localDesktopActiveTab, setLocalDesktopActiveTab] = useState<'for-review' | 'files'>('for-review')
  const [localSelectedFileIds, setLocalSelectedFileIds] = useState<Set<string>>(new Set())
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

  const queueSidebarDownloads = useCallback(async (files: DownloadableFile[], withProgress?: boolean) => {
    if (!files.length) return

    // Estimate total size for local mode warning
    const totalBytes = files.reduce((sum, f) => {
      const rawSize = f.fileSizeBytes
      const parsedSize = typeof rawSize === 'string' ? Number(rawSize) : rawSize
      return sum + (Number.isFinite(parsedSize) ? Number(parsedSize) : 0)
    }, 0)
    // Detect if browser is using Blob fallback (no FSAPI)
    const isLocalMode = typeof window !== 'undefined' && !('showSaveFilePicker' in window)
    if (isLocalMode && totalBytes > 1_000_000_000) { // 1GB threshold
      setShowLocalModeWarning(true)
    } else {
      setShowLocalModeWarning(false)
    }

    if (onDownloadFiles) {
      if (withProgress) {
        await onDownloadFiles(files, (pct) => setDownloadProgress(pct))
      } else {
        await onDownloadFiles(files)
      }
      return
    }

    if (!onDownloadFile) return

    for (let i = 0; i < files.length; i += 1) {
      await onDownloadFile(files[i])
      if (i < files.length - 1) {
        await new Promise<void>((r) => setTimeout(r, 350))
      }
    }
  }, [onDownloadFile, onDownloadFiles])

  const handleDownloadAll = useCallback(async () => {
    if (!downloadableFiles || (!onDownloadFile && !onDownloadFiles)) return
    setIsDownloadingAll(true)
    try {
      const allFiles: DownloadableFile[] = downloadableFiles.flatMap((g) => [
        ...(g.mainFile ? [g.mainFile] : []),
        ...g.subFiles,
      ])
      await queueSidebarDownloads(allFiles)
    } finally {
      setIsDownloadingAll(false)
    }
  }, [downloadableFiles, onDownloadFile, onDownloadFiles, queueSidebarDownloads])

  const handleDownloadSelected = useCallback(async () => {
    if (!downloadableFiles || (!onDownloadFile && !onDownloadFiles) || selectedFileIdsValue.size === 0) return
    setIsDownloadingAll(true)
    setDownloadProgress(null)
    try {
      const allFiles: DownloadableFile[] = downloadableFiles.flatMap((g) => [
        ...(g.mainFile ? [g.mainFile] : []),
        ...g.subFiles,
      ])
      const toDownload = allFiles.filter((file) => {
        const key = getDownloadableFileKey(file)
        return selectedFileIdsValue.has(key)
      })
      await queueSidebarDownloads(toDownload, true)
    } finally {
      setIsDownloadingAll(false)
      setDownloadProgress(null)
    }
  }, [downloadableFiles, onDownloadFile, onDownloadFiles, queueSidebarDownloads, selectedFileIdsValue])

  const handleSelectAll = useCallback(() => {
    if (!downloadableFiles) return
    const allKeys = downloadableFiles
      .flatMap((g) => [...(g.mainFile ? [g.mainFile] : []), ...g.subFiles])
      .map((file) => getDownloadableFileKey(file))
    setSelectedFileIdsValue(new Set(allKeys))
  }, [downloadableFiles, setSelectedFileIdsValue])

  const handleClearSelected = useCallback(() => {
    setSelectedFileIdsValue(new Set())
  }, [setSelectedFileIdsValue])

  const showFiles = downloadableFiles !== undefined && downloadableFiles !== null
  const isMobileFilesMode = desktopActiveTabValue === 'files'

  const canOpenProjectSwitcher = showProjectSwitcher && typeof onProjectSwitcherOpen === 'function'

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

  const renderVideoButton = (group: VideoGroup, showDownloadFiles = false) => {
    const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
    const isActive = !activeAlbumId && activeVideoName === group.name
    const latestVideo = group.videos[0]
    const approvedVideo = group.videos.find((v: any) => v.approved === true)
    const displayVideo = approvedVideo || latestVideo
    const thumbnailUrl = displayVideo?.thumbnailUrl
    const availableContentWidth = sidebarWidth - 48
    const containerWidth = Math.max(120, availableContentWidth - 16)
    const containerHeight = Math.round(containerWidth * 9 / 16)

    const downloadGroup = showDownloadFiles && downloadableFiles
      ? downloadableFiles.find(dg => dg.name === group.name)
      : null
    const downloadFiles = downloadGroup
      ? [...(downloadGroup.mainFile ? [downloadGroup.mainFile] : []), ...downloadGroup.subFiles]
      : []

    const thumbnailEl = thumbnailUrl ? (
      <div
        className="bg-black rounded overflow-hidden flex items-center justify-center mx-auto relative"
        style={{ width: containerWidth, height: containerHeight }}
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
    ) : null

    const titleEl = (
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug line-clamp-2 break-words">{group.name}</p>
            {!showDownloadFiles && (
              <p className="text-xs text-muted-foreground">
                {hideApprovalGrouping && latestVideo?.versionLabel
                  ? latestVideo.versionLabel
                  : `${group.versionCount} ${group.versionCount === 1 ? 'version' : 'versions'}`}
              </p>
            )}
          </div>
        </div>
        {isActive && !showDownloadFiles && (
          hasApprovedVideo ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
          ) : (
            <Play className="w-4 h-4 shrink-0 text-primary" fill="currentColor" />
          )
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
              'w-full text-left p-3 flex flex-col gap-2',
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
                  key={file.assetId ?? `${file.albumId}-${file.variant}`}
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
          'w-full text-left p-3 rounded-lg transition-all duration-200 flex flex-col gap-2',
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

  const renderAlbumButton = (a: typeof albumsList[0], showDownloadFiles = false) => {
    const isActive = activeAlbumId === a.id
    const previewUrl = (a as any)?.thumbnailPhotoUrl as string | null | undefined
    const availableContentWidth = sidebarWidth - 48
    const containerWidth = Math.max(120, availableContentWidth - 16)
    const containerHeight = Math.round(containerWidth * 9 / 16)

    const downloadGroup = showDownloadFiles && downloadableFiles
      ? downloadableFiles.find(dg => dg.name === a.name)
      : null
    const downloadFiles = downloadGroup
      ? [...(downloadGroup.mainFile ? [downloadGroup.mainFile] : []), ...downloadGroup.subFiles]
      : []

    const thumbnailEl = previewUrl ? (
      <div
        className="bg-black rounded overflow-hidden relative mx-auto"
        style={{ width: containerWidth, height: containerHeight }}
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
        className="bg-gradient-to-br from-muted to-muted-foreground rounded flex items-center justify-center mx-auto"
        style={{ width: containerWidth, height: containerHeight }}
      >
        <Images className="w-6 h-6 text-muted-foreground" />
      </div>
    )

    const titleEl = (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug line-clamp-2 break-words">{a.name}</p>
          {!showDownloadFiles && (
            <p className="text-xs text-muted-foreground">
              {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
            </p>
          )}
        </div>
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
              'w-full text-left p-3 flex flex-col gap-2',
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
                  key={file.assetId ?? `${file.albumId}-${file.variant}`}
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
          'w-full text-left p-3 rounded-lg transition-all duration-200 flex flex-col gap-2',
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

  const renderFilesTabSection = (isMobile = false) => (
    <div className="flex flex-col flex-1 min-h-0">
      <div className={cn('overflow-y-auto overflow-x-hidden flex-1', !isMobile && 'mr-[5px]')}>
        {!hasVideos && !hasAlbums ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">No content available for download.</p>
        ) : (
          <div className="py-2">
            {sortedVideoGroups(videoGroups).map((vg) => {
              const dlGroup = downloadableFiles?.find((g) => g.name === vg.name && g.groupType === 'video') ?? null
              const groupFiles: DownloadableFile[] = dlGroup
                ? [...(dlGroup.mainFile ? [dlGroup.mainFile] : []), ...dlGroup.subFiles]
                : []
              const groupFileKeys = groupFiles.map((f) => getDownloadableFileKey(f))
              const allGroupSelected = groupFileKeys.length > 0 && groupFileKeys.every((k) => selectedFileIdsValue.has(k))
              const someGroupSelected = groupFileKeys.some((k) => selectedFileIdsValue.has(k))
              const openMainFilesFolder = () => {
                window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                  detail: { folderName: vg.name },
                }))
              }
              return (
                <div key={vg.name}>
                  <div className="flex items-center gap-2 px-3 pt-2 pb-1">
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
                        'w-3.5 h-3.5 shrink-0 rounded accent-primary',
                        groupFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                    />
                    <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                    <button
                      type="button"
                      className="text-xs font-semibold text-foreground truncate text-left hover:underline"
                      onClick={openMainFilesFolder}
                      title={`Open ${vg.name} in Files`}
                    >
                      {vg.name}
                    </button>
                  </div>
                  {groupFiles.length === 0 ? (
                    <p className="pl-8 pr-3 pb-2 text-xs text-muted-foreground/70 italic">Video is not approved.</p>
                  ) : (
                    groupFiles.map((file) => {
                      const fileKey = getDownloadableFileKey(file)
                      const isChecked = selectedFileIdsValue.has(fileKey)
                      const FileIcon = getFileIcon(file)
                      const isSubFile = file !== dlGroup?.mainFile
                      return (
                        <div
                          key={fileKey}
                          className={cn(
                            'flex items-center gap-2 py-0.5 pr-3 hover:bg-accent transition-colors',
                            isSubFile && dlGroup?.groupType === 'video' ? 'pl-8' : 'pl-6'
                          )}
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
                            className="w-3.5 h-3.5 shrink-0 rounded accent-primary cursor-pointer"
                          />
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span
                            className="flex-1 text-xs text-muted-foreground truncate py-0.5 cursor-default"
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

            {hasAlbums && albumsList.map((a) => {
              const dlGroup = downloadableFiles?.find((g) => g.name === a.name && g.groupType === 'album') ?? null
              const groupFiles: DownloadableFile[] = dlGroup
                ? [...(dlGroup.mainFile ? [dlGroup.mainFile] : []), ...dlGroup.subFiles]
                : []
              const groupFileKeys = groupFiles.map((f) => getDownloadableFileKey(f))
              const allGroupSelected = groupFileKeys.length > 0 && groupFileKeys.every((k) => selectedFileIdsValue.has(k))
              const someGroupSelected = groupFileKeys.some((k) => selectedFileIdsValue.has(k))
              const openMainFilesFolder = () => {
                window.dispatchEvent(new CustomEvent('shareOpenFilesForVideo', {
                  detail: { folderName: a.name },
                }))
              }
              return (
                <div key={a.id}>
                  <div className="flex items-center gap-2 px-3 pt-2 pb-1">
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
                        'w-3.5 h-3.5 shrink-0 rounded accent-primary',
                        groupFileKeys.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                    />
                    <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                    <button
                      type="button"
                      className="text-xs font-semibold text-foreground truncate text-left hover:underline"
                      onClick={openMainFilesFolder}
                      title={`Open ${a.name} in Files`}
                    >
                      {a.name}
                    </button>
                  </div>
                  {groupFiles.length === 0 ? (
                    <p className="pl-8 pr-3 pb-2 text-xs text-muted-foreground/70 italic">No files available.</p>
                  ) : (
                    groupFiles.map((file) => {
                      const fileKey = getDownloadableFileKey(file)
                      const isChecked = selectedFileIdsValue.has(fileKey)
                      const FileIcon = getFileIcon(file)
                      return (
                        <div
                          key={fileKey}
                          className="flex items-center gap-2 py-0.5 pl-6 pr-3 hover:bg-accent transition-colors"
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
                            className="w-3.5 h-3.5 shrink-0 rounded accent-primary cursor-pointer"
                          />
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span
                            className="flex-1 text-xs text-muted-foreground truncate py-0.5 cursor-default"
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
          </div>
        )}
      </div>

      {downloadableFiles && downloadableFiles.length > 0 && (onDownloadFile || onDownloadFiles) && (
        <div className={cn('flex-shrink-0 border-t border-border bg-card p-2 space-y-1.5', isMobile && 'sticky bottom-0')}>
          {/* Progress bar above buttons */}
          {isDownloadingAll && downloadProgress !== null && (
            <div className="w-full mb-2">
              <div className="h-2 bg-muted rounded overflow-hidden">
                <div
                  className="bg-primary transition-all h-2"
                  style={{ width: `${downloadProgress}%` }}
                  role="progressbar"
                  aria-valuenow={Math.round(downloadProgress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <div className="text-xs text-muted-foreground mt-1 text-center">Zipping… {Math.round(downloadProgress)}%</div>
            </div>
          )}
          {/* Local mode warning for large ZIPs */}
          {showLocalModeWarning && (
            <div className="mb-2 p-2 rounded bg-yellow-100 text-yellow-900 text-xs border border-yellow-300">
              Warning: Your browser does not support direct-to-disk ZIP streaming. Large downloads (&gt;1GB) may fail or crash. For best results, use Chrome or Edge.
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
              ? downloadProgress !== null
                ? `Zipping… ${Math.round(downloadProgress)}%`
                : 'Preparing…'
              : selectedFileIdsValue.size > 0
              ? `Download (${selectedFileIdsValue.size})`
              : 'Download'}
          </button>
        </div>
      )}
    </div>
  )

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
                      <div className="space-y-1 mb-4">
                        {flatAlphabeticalGroups.map(g => renderVideoButton(g))}
                      </div>
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
                                  key={file.assetId ?? `${file.albumId}-${file.variant}`}
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
                    {/* FOR REVIEW videos — no heading, the tab label is enough */}
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
                        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 border-t border-border pt-3">
                          <Images className="w-3 h-3" />
                          Albums
                        </div>
                        <div className="space-y-1">
                          {albumsList.map(a => renderAlbumButton(a))}
                        </div>
                      </div>
                    )}
                  </nav>
                </div>
              )}

              {/* FILES tab */}
              {desktopActiveTabValue === 'files' && renderFilesTabSection(false)}
            </>
          )}
        </div>

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
                </div>
              </div>
            )}
          </div>
      </div>

    </>
  )
}
