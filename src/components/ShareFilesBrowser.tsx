'use client'

import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import type { TransferItem } from '@/lib/transfer-state'
import {
  ArrowLeft,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  Files,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Pencil,
  MoreHorizontal,
  Play,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react'

type DownloadProgressSnapshot = {
  percent: number
  speedBytesPerSecond: number | null
  etaSeconds: number | null
}

const FILES_CHECKBOX_CLASS = 'rounded accent-primary/75 opacity-70 checked:opacity-100 transition-opacity'

const isSelectableDownloadableFile = (file: DownloadableFile): boolean => {
  if (file.type !== 'video') return true
  return file.isApproved === true
}

type ShareFilesBrowserProps = {
  groups: DownloadableGroup[]
  rootFolderLabel?: string
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

function isLightboxMediaFile(file: DownloadableFile): boolean {
  const kind = getDownloadableFileKind(file)
  if (kind === 'image' || kind === 'audio') return true
  if (kind === 'video' && file.type !== 'video') return true
  return false
}

export function ShareFilesBrowser({
  groups,
  rootFolderLabel,
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
}: ShareFilesBrowserProps) {
  const [openFolderName, setOpenFolderName] = useState<string | null>(null)
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false)
  const [localDownloadProgress, setLocalDownloadProgress] = useState<DownloadProgressSnapshot | null>(null)
  const [previewUrlByFileKey, setPreviewUrlByFileKey] = useState<Record<string, string | null>>({})
  const [derivedVideoDurationByFileKey, setDerivedVideoDurationByFileKey] = useState<Record<string, number | null>>({})
  const [folderPreviewTilesByName, setFolderPreviewTilesByName] = useState<Record<string, string[]>>({})
  const [folderPreviewPosterByName, setFolderPreviewPosterByName] = useState<Record<string, string | null>>({})
  const [lightboxState, setLightboxState] = useState<{ images: DownloadableFile[]; currentIndex: number } | null>(null)
  const [audioLightboxState, setAudioLightboxState] = useState<{ files: DownloadableFile[]; currentIndex: number } | null>(null)
  const [audioPlaybackUrlByFileKey, setAudioPlaybackUrlByFileKey] = useState<Record<string, string | null>>({})
  const [videoPlaybackUrlByFileKey, setVideoPlaybackUrlByFileKey] = useState<Record<string, string | null>>({})
  const [albumViewerState, setAlbumViewerState] = useState<{ images: DownloadableFile[]; currentIndex: number; albumId: string | null } | null>(null)
  const [albumPhotoMetaByPhotoId, setAlbumPhotoMetaByPhotoId] = useState<Record<string, { socialDownloadUrl: string; socialReady: boolean }>>({})
  const [albumSocialEnabledByAlbumId, setAlbumSocialEnabledByAlbumId] = useState<Record<string, boolean>>({})
  const [albumMetaLoadedByAlbumId, setAlbumMetaLoadedByAlbumId] = useState<Record<string, boolean>>({})
  const [isUploadActionBusy, setIsUploadActionBusy] = useState(false)
  const [videoAssetsThumbnailSize, setVideoAssetsThumbnailSize] = useState<'default' | 'large'>('default')
  const [albumPhotosThumbnailSize, setAlbumPhotosThumbnailSize] = useState<'default' | 'large'>('default')
  const [pendingUploadFolderPath, setPendingUploadFolderPath] = useState<string>('')
  const [visibleFolderNames, setVisibleFolderNames] = useState<Set<string>>(new Set())
  const [visibleFileKeys, setVisibleFileKeys] = useState<Set<string>>(new Set())
  const previewRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const audioPlaybackRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const videoPlaybackRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const previewRetryTimerRef = useRef<Map<string, number>>(new Map())
  const previewRetryAttemptRef = useRef<Map<string, number>>(new Map())
  const uploadVideoDurationRequestRef = useRef<Map<string, Promise<number | null>>>(new Map())
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const folderCardObserverRef = useRef<IntersectionObserver | null>(null)
  const fileCardObserverRef = useRef<IntersectionObserver | null>(null)
  const folderCardNodesRef = useRef<Map<string, Element>>(new Map())
  const fileCardNodesRef = useRef<Map<string, Element>>(new Map())

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

  const captureVideoPoster = useCallback(async (videoUrl: string): Promise<string | null> => {
    if (!videoUrl) return null

    return await new Promise((resolve) => {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.preload = 'metadata'
      video.muted = true
      video.playsInline = true

      let settled = false
      const cleanup = () => {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }

      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }

      const capture = () => {
        try {
          if (!video.videoWidth || !video.videoHeight) {
            finish(null)
            return
          }

          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const context = canvas.getContext('2d')
          if (!context) {
            finish(null)
            return
          }

          context.drawImage(video, 0, 0, canvas.width, canvas.height)
          const poster = canvas.toDataURL('image/jpeg', 0.8)
          finish(poster && poster !== 'data:,' ? poster : null)
        } catch {
          finish(null)
        }
      }

      video.addEventListener('loadedmetadata', () => {
        try {
          const targetTime = Math.min(0.75, Math.max(0.1, (video.duration || 0) * 0.1))
          if (Number.isFinite(targetTime) && targetTime > 0 && video.duration > targetTime) {
            video.currentTime = targetTime
            return
          }
        } catch {
          // ignore and capture the first available frame
        }

        capture()
      }, { once: true })
      video.addEventListener('loadeddata', capture, { once: true })
      video.addEventListener('seeked', capture, { once: true })
      video.addEventListener('error', () => finish(null), { once: true })
      video.src = videoUrl

      window.setTimeout(() => finish(null), 10000)
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

  const rootAlbumGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType === 'album'),
    [sortedGroups]
  )

  const rootUploadGroups = useMemo(
    () => sortedGroups.filter((group) => group.groupType === 'uploads'),
    [sortedGroups]
  )

  const rootUploadsSectionGroups = useMemo(
    () => rootUploadGroups.filter((group) => group.name === 'UPLOADS'),
    [rootUploadGroups]
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

  const splitRootSections = [
    rootVideoGroups.length > 0,
    rootAlbumGroups.length > 0,
  ].filter(Boolean).length > 1

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

  useEffect(() => {
    if (!openFolderName) return
    if (openFolderName === 'UPLOADS' && rootUploadGroups.length > 0) {
      return
    }
    if (!sortedGroups.some((group) => group.name === openFolderName)) {
      setOpenFolderName(null)
    }
  }, [openFolderName, sortedGroups, rootUploadGroups.length])

  useEffect(() => {
    const requested = String(requestedOpenFolderName || '').trim()
    if (!requested) return

    if (requested === 'UPLOADS' && rootUploadGroups.length > 0) {
      setOpenFolderName('UPLOADS')
      return
    }

    const matchingGroup = sortedGroups.find((group) => group.name === requested)
    if (matchingGroup) {
      setOpenFolderName(matchingGroup.name)
      return
    }

    setOpenFolderName(null)
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
    if (!relativePath) return 'UPLOADS'
    return relativePath
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
      setOpenFolderName(null)
      return
    }

    const parentSegments = segments.slice(0, -1)
    const resolvedParentName = resolveFolderNameFromSegments(parentSegments)
    if (!resolvedParentName) {
      setOpenFolderName(null)
      return
    }

    if (resolvedParentName === 'UPLOADS' && rootUploadGroups.length === 0) {
      setOpenFolderName(null)
      return
    }

    setOpenFolderName(resolvedParentName)
  }, [openFolderName, getFolderHierarchySegments, resolveFolderNameFromSegments, rootUploadGroups.length])

  useEffect(() => {
    onOpenFolderNameChange?.(openFolderName)
  }, [openFolderName, onOpenFolderNameChange])

  useEffect(() => {
    const handleOpenRoot = () => {
      setOpenFolderName(null)
    }

    window.addEventListener('shareOpenFilesRoot', handleOpenRoot)
    return () => {
      window.removeEventListener('shareOpenFilesRoot', handleOpenRoot)
    }
  }, [])

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
              if (typeof videoUrl === 'string' && videoUrl.length > 0) {
                nextPoster[group.name] = videoCandidate.type === 'upload-file'
                  ? videoUrl
                  : await captureVideoPoster(videoUrl)
              } else {
                nextPoster[group.name] = null
              }
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
    captureVideoPoster,
    visibleFolderNames,
    folderPreviewTilesByName,
    folderPreviewPosterByName,
  ])

  useEffect(() => {
    if (!filesInOpenFolder.length) return

    filesInOpenFolder.forEach((file) => {
      const fileKey = getDownloadableFileKey(file)
      if (!visibleFileKeys.has(fileKey)) return
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

          let displayUrl = url
          if (fileKind === 'video' && looksLikeVideoUrl(url)) {
            const poster = await captureVideoPoster(url)
            if (poster) {
              displayUrl = poster
            }
          }

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
    captureVideoPoster,
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
    const fileKeys = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
      .filter((file) => isSelectableDownloadableFile(file))
      .map(getDownloadableFileKey)
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
      .filter((file) => isSelectableDownloadableFile(file))
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
    ? filesInOpenFolder
    : [...projectRootGroups, ...rootUploadsSectionGroups].flatMap((group) => [
        ...(group.mainFile ? [group.mainFile] : []),
        ...group.subFiles,
      ])
  const selectedUploadFilesInContext = useMemo(() => {
    if (!isUploadsContext) return [] as DownloadableFile[]
    return visibleFiles.filter((file) => file.type === 'upload-file' && selectedFileIds.has(getDownloadableFileKey(file)))
  }, [isUploadsContext, visibleFiles, selectedFileIds])

  useEffect(() => {
    // Keep selection valid across folder changes without dropping items selected from other sections.
    const selectableKeys = new Set(
      groups
        .flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
        .filter((file) => isSelectableDownloadableFile(file))
        .map((file) => getDownloadableFileKey(file))
    )

    setSelectedFileIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((key) => selectableKeys.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [groups, setSelectedFileIds])

  const selectAllVisible = () => {
    const visibleKeys = visibleFiles
      .filter((file) => isSelectableDownloadableFile(file))
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
    const visibleSelectableKeys = visibleFiles
      .filter((file) => isSelectableDownloadableFile(file))
      .map(getDownloadableFileKey)
    return visibleSelectableKeys.length > 0 && visibleSelectableKeys.every((key) => selectedFileIds.has(key))
  }, [visibleFiles, selectedFileIds])

  const toggleAllVisibleSelection = () => {
    if (allVisibleSelected) {
      clearSelection()
      return
    }
    selectAllVisible()
  }

  const downloadSelected = async () => {
    const scopedFiles = openFolder
      ? filesInOpenFolder
      : groups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
    const selectedFiles = scopedFiles.filter((file) => selectedFileIds.has(getDownloadableFileKey(file)))
      .filter((file) => file.type !== 'video' || file.isApproved !== false)
    if (!selectedFiles.length) return

    setIsDownloadingSelected(true)
    setLocalDownloadProgress(null)
    try {
      if (onDownloadFiles) {
        await onDownloadFiles(selectedFiles, (progress) => setLocalDownloadProgress(progress))
      } else {
        await Promise.all(selectedFiles.map((file) => onDownloadFile(file).catch(() => undefined)))
      }
    } finally {
      setIsDownloadingSelected(false)
      setLocalDownloadProgress(null)
    }
  }

  const isDownloadBusy = isDownloadingSelected
  const activeProgress = localDownloadProgress

  const runCreateUploadFolder = useCallback(async () => {
    if (!canUploadToProjects || !onCreateUploadFolder || isUploadActionBusy) return
    const folderName = window.prompt('Folder name')
    const normalizedName = String(folderName || '').trim()
    if (!normalizedName) return

    setIsUploadActionBusy(true)
    try {
      await onCreateUploadFolder(uploadsTargetFolderPath, normalizedName)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to create folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [canUploadToProjects, onCreateUploadFolder, isUploadActionBusy, uploadsTargetFolderPath])

  const openUploadFilePicker = useCallback(() => {
    if (!canUploadToProjects || !onUploadFiles || isUploadActionBusy) return
    setPendingUploadFolderPath(uploadsTargetFolderPath)
    uploadInputRef.current?.click()
  }, [canUploadToProjects, onUploadFiles, isUploadActionBusy, uploadsTargetFolderPath])

  const deleteSelectedUploadFiles = useCallback(async () => {
    if (!canDeleteUploads || !onDeleteUploadFile || isUploadActionBusy) return
    if (selectedUploadFilesInContext.length === 0) return

    const count = selectedUploadFilesInContext.length
    const shouldDelete = window.confirm(`Delete ${count} selected upload file${count === 1 ? '' : 's'}?`)
    if (!shouldDelete) return

    setIsUploadActionBusy(true)
    try {
      for (const file of selectedUploadFilesInContext) {
        if (!file.uploadFileId) continue
        await onDeleteUploadFile(file.uploadFileId)
      }

      const deletedKeys = new Set(selectedUploadFilesInContext.map((file) => getDownloadableFileKey(file)))
      setSelectedFileIds((prev) => new Set(Array.from(prev).filter((key) => !deletedKeys.has(key))))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to delete selected files')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [
    canDeleteUploads,
    onDeleteUploadFile,
    isUploadActionBusy,
    selectedUploadFilesInContext,
    setSelectedFileIds,
  ])

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

  const deleteUploadFile = useCallback(async (fileId: string) => {
    if (!canDeleteUploads || !onDeleteUploadFile || !fileId || isUploadActionBusy) return
    const shouldDelete = window.confirm('Delete this uploaded file?')
    if (!shouldDelete) return
    setIsUploadActionBusy(true)
    try {
      await onDeleteUploadFile(fileId)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to delete file')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [canDeleteUploads, onDeleteUploadFile, isUploadActionBusy])

  const deleteUploadFolder = useCallback(async (folderPath: string) => {
    if (!canDeleteUploads || !onDeleteUploadFolder || !folderPath || isUploadActionBusy) return
    const shouldDelete = window.confirm('Delete this folder and all nested files?')
    if (!shouldDelete) return
    setIsUploadActionBusy(true)
    try {
      await onDeleteUploadFolder(folderPath)
      setOpenFolderName(null)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to delete folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [canDeleteUploads, onDeleteUploadFolder, isUploadActionBusy])

  const renameUploadFolder = useCallback(async (folderPath: string, currentFolderName: string) => {
    if (!canDeleteUploads || !onRenameUploadFolder || !folderPath || isUploadActionBusy) return

    const nextName = window.prompt('New folder name', currentFolderName)
    const normalizedName = String(nextName || '').trim()
    if (!normalizedName || normalizedName === currentFolderName) return

    setIsUploadActionBusy(true)
    try {
      await onRenameUploadFolder(folderPath, normalizedName)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to rename folder')
    } finally {
      setIsUploadActionBusy(false)
    }
  }, [canDeleteUploads, onRenameUploadFolder, isUploadActionBusy])

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

  const openFolderVideoVersions = useMemo(() => {
    if (openFolder?.groupType !== 'video') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'video')].sort(compareVideoVersionDesc)
  }, [openFolder?.groupType, filesInOpenFolder, compareVideoVersionDesc])

  const openFolderVideoAssets = useMemo(() => {
    if (openFolder?.groupType !== 'video') return [] as DownloadableFile[]
    return [...filesInOpenFolder.filter((file) => file.type === 'asset')].sort(compareFileNameAsc)
  }, [openFolder?.groupType, filesInOpenFolder, compareFileNameAsc])

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
  const nestedUploadFoldersInRoot = useMemo(
    () => openUploadsRoot ? rootUploadGroups.filter((group) => group.name !== 'UPLOADS') : [],
    [openUploadsRoot, rootUploadGroups]
  )
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
      const res = await fetch(`/api/share/${encodeURIComponent(shareSlug)}/albums/${encodeURIComponent(albumId)}`, {
        cache: 'no-store',
        headers: shareToken ? { Authorization: `Bearer ${shareToken}` } : undefined,
      })
      if (!res.ok) {
        setAlbumMetaLoadedByAlbumId((prev) => ({ ...prev, [albumId]: true }))
        return
      }

      const data = await res.json().catch(() => ({}))
      const photos = Array.isArray((data as any)?.photos) ? (data as any).photos : []
      const socialEnabled = (data as any)?.album?.socialCopiesEnabled !== false

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
      // Ignore metadata fetch errors; full-resolution download remains available.
    } finally {
      setAlbumMetaLoadedByAlbumId((prev) => ({ ...prev, [albumId]: true }))
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
    const sizeLabel = formatFileSize(file.fileSizeBytes)
    const durationLabel = fileKind === 'video'
      ? formatDuration(file.durationSeconds ?? derivedVideoDurationByFileKey[fileKey] ?? undefined)
      : null
    const fileExtensionLabel = getFileExtensionLabel(file.fileName)
    const canDownloadFile = file.type !== 'video' || file.isApproved !== false
    const canSelectFile = isSelectableDownloadableFile(file)
    const displayFileName = file.type === 'video'
      ? `${openFolder?.name || file.fileName} - ${file.versionLabel || 'Version'}`
      : file.fileName
    const latestVideoVersionKey = openFolderVideoVersions.length > 0
      ? getDownloadableFileKey(openFolderVideoVersions[0])
      : null
    const showForReviewBadge = file.type === 'video' && file.isApproved === false && latestVideoVersionKey === fileKey
    const videoVersionsInGroup = imageList.filter((entry) => entry.type === 'video')
    const hasMultipleVideoVersions = videoVersionsInGroup.length > 1
    const hasApprovedVideoVersionInGroup = videoVersionsInGroup.some((entry) => entry.isApproved === true)
    const muteInactiveVideoVersion =
      file.type === 'video' &&
      hasMultipleVideoVersions &&
      hasApprovedVideoVersionInGroup &&
      file.isApproved !== true
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
    const showPlayableVideoOverlay = (isVideoAssetFile || (file.type === 'video' && !muteInactiveVideoVersion)) && (showImagePreview || showVideoPreview)
    const actionButtons = canDownloadFile ? (
      <div className="flex items-center gap-1">
        {file.type === 'upload-file' && canDeleteUploads && onDeleteUploadFile && file.uploadFileId ? (
          <Button
            type="button"
            variant="outline"
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
          variant="outline"
          size="icon"
          className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-7 w-7')}
          disabled={muteInactiveVideoVersion}
          onClick={(event) => { event.stopPropagation(); void onDownloadFile(file) }}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={`Download ${file.fileName}`}
          title={`Download ${file.fileName}`}
        >
          <Download className={cn(compact ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
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
          muteInactiveVideoVersion && 'opacity-55 saturate-0',
          isSelected
            ? 'border-2 border-primary/85 hover:border-primary'
            : 'border border-border hover:border-primary/45'
        )}
        onClick={() => {
          if (muteInactiveVideoVersion) return
          if (isImageFile) {
            openImageLightbox(file, imageList)
            return
          }
          if (isAudioFile) {
            openAudioLightbox(file, imageList)
          }
        }}
        onDoubleClick={() => {
          if (muteInactiveVideoVersion) return
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
      >
        <div className={cn('relative bg-gradient-to-b from-muted/70 to-muted/35', compact ? 'p-2 pb-1.5' : 'p-2.5 pb-2')}>
          <div className={cn('relative rounded-lg border border-border/80 bg-card shadow-inner shadow-black/10', compact ? 'p-1' : 'p-1.5')}>
            <div className={cn('relative rounded-md overflow-hidden bg-black/85', compact ? 'aspect-[4/3]' : 'aspect-[16/10]')}>
              {showImagePreview ? (
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
                <div className="absolute top-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[11px] leading-none text-white font-medium">
                  {file.versionLabel}
                </div>
              ) : null}

              {file.type === 'video' && file.isApproved === true ? (
                <div className="absolute bottom-2 left-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[11px] leading-none text-white font-semibold tracking-wide">
                  APPROVED
                </div>
              ) : null}

              {showForReviewBadge ? (
                <div className="absolute bottom-2 left-2 rounded bg-amber-500/95 px-1.5 py-0.5 text-[11px] leading-none text-black font-semibold tracking-wide">
                  FOR REVIEW
                </div>
              ) : null}
            </div>

            <div className="absolute top-2 left-2">
              <input
                type="checkbox"
                checked={isSelected}
                disabled={!canSelectFile || muteInactiveVideoVersion}
                onChange={(event) => {
                  if (!canSelectFile || muteInactiveVideoVersion) return
                  toggleFile(fileKey, event.target.checked)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                className={cn(
                  'w-4 h-4',
                  FILES_CHECKBOX_CLASS,
                  canSelectFile && !muteInactiveVideoVersion ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                )}
                aria-label={`Select ${file.fileName}`}
              />
            </div>
          </div>
        </div>

        <div className={cn(compact ? 'px-2 py-2' : 'px-3 py-2.5')}>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileTypeIcon className={cn('text-muted-foreground shrink-0', compact ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
              <p className={cn('font-semibold text-foreground truncate', compact ? 'text-xs' : 'text-sm')} title={displayFileName}>{displayFileName}</p>
            </div>
            {keepActionsOnTitleRow ? actionButtons : null}
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

  const renderRootFolderCard = (group: DownloadableGroup) => {
    const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
    const uploadFolderPath = group.groupType === 'uploads' ? getUploadsFolderPathFromGroup(group.name) : ''
    const displayGroupName = group.groupType === 'uploads'
      ? getUploadsFolderLabelFromGroup(group.name)
      : group.name
    const groupVideoFiles = groupFiles.filter((file) => file.type === 'video')
    const groupHasApprovedVideo = groupVideoFiles.some((file) => file.isApproved === true)
    const showVideoFolderApprovedBadge = group.groupType === 'video' && groupHasApprovedVideo
    const showVideoFolderForReviewBadge = group.groupType === 'video' && !groupHasApprovedVideo
    const groupFileKeys = groupFiles.map(getDownloadableFileKey)
    const allChecked = groupFileKeys.length > 0 && groupFileKeys.every((key) => selectedFileIds.has(key))
    const someChecked = groupFileKeys.some((key) => selectedFileIds.has(key))
    const folderPreview = folderPreviewByName?.[group.name] || null
    const folderPreviewTiles = folderPreviewTilesByName[group.name] || []
    const folderVideoPreviewUrl = folderPreviewPosterByName[group.name] || null
    const leadPreview = folderPreviewTiles[0] || null
    const sidePreviewTop = folderPreviewTiles[1] || null
    const sidePreviewBottom = folderPreviewTiles[2] || null
    const showVideoFolderPreview = !leadPreview && Boolean(folderVideoPreviewUrl) && group.groupType === 'uploads'

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
        onDoubleClick={() => setOpenFolderName(group.name)}
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
      >
        <div className="relative p-2.5 pb-2 bg-gradient-to-b from-muted/80 via-muted/45 to-background">
          <div className="relative pt-2">
            <div className="absolute left-3 top-0 h-2.5 w-16 rounded-t-md border border-b-0 border-primary/55 bg-primary/30" />
            <div className="relative rounded-lg rounded-tl-sm border border-primary/50 bg-primary/20 p-1.5 shadow-inner shadow-black/10">
              <div className="grid grid-cols-3 grid-rows-2 gap-1.5 aspect-[16/10] rounded-md overflow-hidden bg-primary/20">
                {leadPreview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={leadPreview}
                      alt={group.name}
                      className="col-span-2 row-span-2 h-full w-full object-contain bg-black"
                      loading="lazy"
                    />

                    {sidePreviewTop ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sidePreviewTop}
                        alt=""
                        aria-hidden="true"
                        className="h-full w-full object-contain bg-black"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-full w-full bg-primary/35" aria-hidden="true" />
                    )}

                    {sidePreviewBottom ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={sidePreviewBottom}
                        alt=""
                        aria-hidden="true"
                        className="h-full w-full object-contain bg-black"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-full w-full bg-primary/30" aria-hidden="true" />
                    )}
                  </>
                ) : folderPreview ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={folderPreview}
                      alt={group.name}
                      className="col-span-2 row-span-2 h-full w-full object-contain bg-black"
                      loading="lazy"
                    />
                    <div className="h-full w-full bg-primary/35" aria-hidden="true" />
                    <div className="h-full w-full bg-primary/30" aria-hidden="true" />
                  </>
                ) : showVideoFolderPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={folderVideoPreviewUrl || undefined}
                    alt={group.name}
                    className="col-span-3 row-span-2 h-full w-full object-contain bg-black"
                    loading="lazy"
                  />
                ) : (
                  <div className="col-span-3 row-span-2 h-full w-full flex items-center justify-center text-primary/70">
                    <Folder className="w-9 h-9" />
                  </div>
                )}
              </div>
            </div>
          </div>

          {showVideoFolderApprovedBadge ? (
            <div className="absolute bottom-2 left-2 rounded bg-emerald-600/90 px-1.5 py-0.5 text-[11px] leading-none text-white font-semibold tracking-wide">
              APPROVED
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
              ref={(el) => {
                if (el) el.indeterminate = someChecked && !allChecked
              }}
              onChange={(event) => toggleGroup(group, event.target.checked)}
              className={cn('w-4 h-4', FILES_CHECKBOX_CLASS, groupFiles.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40')}
              aria-label={`Select files in ${displayGroupName}`}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOpenFolderName(group.name)}
          className="w-full text-left px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Folder className="w-4 h-4 text-primary shrink-0" />
              <span className="text-sm font-semibold text-foreground truncate">{displayGroupName}</span>
            </div>
            <div className="flex items-center gap-1">
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
        </button>
      </div>
    )
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex-1 min-h-0 flex flex-col">
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
        <div className="min-w-0 flex items-center justify-between gap-2 sm:flex-1">
          <div className="min-w-0">
            {openFolder ? (
              <div className="flex items-center gap-2 min-w-0">
                <Button type="button" variant="outline" size="sm" className="px-2 sm:px-3" onClick={navigateBackFolder}>
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Back</span>
                </Button>
                {selectedCount > 0 ? (
                  <span className="hidden sm:inline text-xs sm:text-sm text-muted-foreground truncate">
                    {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                  </span>
                ) : null}
              </div>
            ) : (
              selectedCount > 0 ? (
                <span className="hidden sm:inline text-xs sm:text-sm text-muted-foreground truncate">
                  {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                </span>
              ) : (
                <span className="sr-only">Root folder</span>
              )
            )}
          </div>
          <div className="ml-auto flex items-center gap-2 sm:hidden">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2"
              disabled={visibleFiles.length === 0}
              onClick={toggleAllVisibleSelection}
              aria-label={allVisibleSelected ? 'Unselect all visible files' : 'Select all visible files'}
              title={allVisibleSelected ? 'Unselect all visible files' : 'Select all visible files'}
            >
              {allVisibleSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <Files className="w-4 h-4" />
            </Button>
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
          </div>
          <div className="hidden sm:flex items-center gap-2 ml-auto">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2"
              disabled={visibleFiles.length === 0}
              onClick={toggleAllVisibleSelection}
              aria-label={allVisibleSelected ? 'Unselect all visible files' : 'Select all visible files'}
              title={allVisibleSelected ? 'Unselect all visible files' : 'Select all visible files'}
            >
              {allVisibleSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              <Files className="w-4 h-4" />
            </Button>
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
            {onCloseFilesView ? (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="h-8 w-8"
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
        className="flex-1 min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-4"
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
          <div className={cn(splitRootSections ? 'space-y-5' : 'space-y-2')}>
            <h4 className="px-1 text-base sm:text-lg font-bold uppercase tracking-wider text-white truncate" title={rootFolderLabel || 'PROJECT'}>
              {rootFolderLabel || 'PROJECT'}
            </h4>
            {splitRootSections ? (
              <>
                {rootVideoGroups.length > 0 ? (
                  <section className="space-y-2">
                    <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Videos</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {rootVideoGroups.map((group) => renderRootFolderCard(group))}
                    </div>
                  </section>
                ) : null}

                {rootAlbumGroups.length > 0 ? (
                  <section className="space-y-2 border-t border-border/70 pt-4">
                    <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Albums</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {rootAlbumGroups.map((group) => renderRootFolderCard(group))}
                    </div>
                  </section>
                ) : null}

                {rootUploadsSectionGroups.length > 0 ? (
                  <section className="space-y-2 border-t border-border/70 pt-4">
                    <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">UPLOADS</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {rootUploadsSectionGroups.map((group) => renderRootFolderCard(group))}
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                  {projectRootGroups.map((group) => renderRootFolderCard(group))}
                </div>
                {rootUploadsSectionGroups.length > 0 ? (
                  <section className={cn('space-y-2', projectRootGroups.length > 0 ? 'border-t border-border/70 pt-4' : '')}>
                    <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">UPLOADS</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {rootUploadsSectionGroups.map((group) => renderRootFolderCard(group))}
                    </div>
                  </section>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {openFolder?.groupType === 'video' ? (
              <>
                <section className="space-y-2">
                  <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Videos</h4>
                  {openFolderVideoVersions.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {openFolderVideoVersions.map((file) => renderOpenFolderFileCard(file, false, openFolderVideoVersions))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">No video versions available.</p>
                  )}
                </section>

                <section className="space-y-2 border-t border-border/70 pt-4">
                  <div className="px-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={videoAssetsSelection.allChecked}
                      disabled={openFolderVideoAssets.length === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = videoAssetsSelection.someChecked
                      }}
                      onChange={(event) => toggleSubset(openFolderVideoAssets, event.target.checked)}
                      className={cn(
                        'w-4 h-4',
                        FILES_CHECKBOX_CLASS,
                        openFolderVideoAssets.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                      aria-label="Select all video assets"
                    />
                    <h4 className="text-base sm:text-lg font-bold tracking-wider text-white">Video Assets</h4>
                    <div className="ml-auto inline-flex items-center rounded-md border border-border overflow-hidden">
                      <button
                        type="button"
                        className={cn(
                          'px-2 py-1 text-[11px] font-semibold transition-colors',
                          videoAssetsThumbnailSize === 'default'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setVideoAssetsThumbnailSize('default')}
                      >
                        Default
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'px-2 py-1 text-[11px] font-semibold transition-colors border-l border-border',
                          videoAssetsThumbnailSize === 'large'
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setVideoAssetsThumbnailSize('large')}
                      >
                        Large
                      </button>
                    </div>
                  </div>
                  {openFolderVideoAssets.length > 0 ? (
                    <div className={cn(
                      'grid',
                      videoAssetsThumbnailSize === 'large'
                        ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3'
                        : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5'
                    )}>
                      {openFolderVideoAssets.map((file) => renderOpenFolderFileCard(file, videoAssetsThumbnailSize !== 'large', openFolderVideoAssets))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">There are currently no Video Assets for this video.</p>
                  )}
                </section>
              </>
            ) : openFolder?.groupType === 'album' ? (
              <>
                <section className="space-y-2">
                  <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Albums</h4>
                  {openFolderAlbumZips.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {openFolderAlbumZips.map((file) => renderOpenFolderFileCard(file))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">No album ZIPs available.</p>
                  )}
                </section>

                <section className="space-y-2 border-t border-border/70 pt-4">
                  <div className="px-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={albumPhotosSelection.allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = albumPhotosSelection.someChecked
                      }}
                      onChange={(event) => toggleSubset(openFolderAlbumPhotos, event.target.checked)}
                      className={cn('w-4 h-4', FILES_CHECKBOX_CLASS, 'cursor-pointer')}
                      aria-label="Select all photos"
                    />
                    <h4 className="text-base sm:text-lg font-bold tracking-wider text-white">Photos</h4>
                    <div className="ml-auto inline-flex items-center rounded-md border border-border overflow-hidden">
                      <button
                        type="button"
                        className={cn(
                          'px-2 py-1 text-[11px] font-semibold transition-colors',
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
                  {openFolderAlbumPhotos.length > 0 ? (
                    <div className={cn(
                      'grid',
                      albumPhotosThumbnailSize === 'large'
                        ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3'
                        : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5'
                    )}>
                      {openFolderAlbumPhotos.map((file) => renderOpenFolderFileCard(file, albumPhotosThumbnailSize !== 'large', openFolderAlbumPhotos))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">No photos available.</p>
                  )}
                </section>
              </>
            ) : (
              <>
                {openUploadsRoot && nestedUploadFoldersInRoot.length > 0 ? (
                  <section className="space-y-2">
                    <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Folders</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {nestedUploadFoldersInRoot.map((group) => renderRootFolderCard(group))}
                    </div>
                  </section>
                ) : null}

                <section className={cn('space-y-2', openUploadsRoot && nestedUploadFoldersInRoot.length > 0 ? 'border-t border-border/70 pt-4' : '')}>
                  <div className="px-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={uploadFilesSelection.allChecked}
                      disabled={openFolderUploadFiles.length === 0}
                      ref={(el) => {
                        if (el) el.indeterminate = uploadFilesSelection.someChecked
                      }}
                      onChange={(event) => toggleSubset(openFolderUploadFiles, event.target.checked)}
                      className={cn(
                        'w-4 h-4',
                        FILES_CHECKBOX_CLASS,
                        openFolderUploadFiles.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
                      )}
                      aria-label="Select all uploads"
                    />
                    <h4 className="text-base sm:text-lg font-bold tracking-wider text-white">Uploads</h4>
                  </div>
                  {openFolderUploadFiles.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5">
                      {openFolderUploadFiles.map((file) => renderOpenFolderFileCard(file, true, openFolderUploadFiles))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">No uploaded files available.</p>
                  )}
                </section>
              </>
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
            <DialogContent className="max-w-[92vw] sm:max-w-5xl p-0 overflow-hidden bg-black border-border">
              {lightboxFile ? (
                <div className="relative w-full h-[70vh] bg-black">
                  {isVideoLightbox && lightboxSrc ? (
                    <video
                      src={lightboxSrc}
                      className="w-full h-full object-contain"
                      controls
                      autoPlay
                      playsInline
                      controlsList="nodownload noplaybackrate noremoteplayback"
                      disablePictureInPicture
                      onContextMenu={(event) => event.preventDefault()}
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
            <DialogContent className="max-w-[92vw] sm:max-w-3xl p-0 overflow-hidden bg-black border-border">
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
            <DialogContent className="max-w-none w-[95vw] h-[95vh] flex flex-col">
              {viewerFile && viewerSrc ? (
                <div className="flex-1 min-h-0 flex flex-col gap-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0">
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
    </div>
  )
}
