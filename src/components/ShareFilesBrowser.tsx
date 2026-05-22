'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  MoreHorizontal,
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
  shareSlug?: string
  shareToken?: string | null
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
  shareSlug,
  shareToken,
}: ShareFilesBrowserProps) {
  const [openFolderName, setOpenFolderName] = useState<string | null>(null)
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false)
  const [localDownloadProgress, setLocalDownloadProgress] = useState<DownloadProgressSnapshot | null>(null)
  const [previewUrlByFileKey, setPreviewUrlByFileKey] = useState<Record<string, string | null>>({})
  const [folderPreviewTilesByName, setFolderPreviewTilesByName] = useState<Record<string, string[]>>({})
  const [lightboxState, setLightboxState] = useState<{ images: DownloadableFile[]; currentIndex: number } | null>(null)
  const [albumViewerState, setAlbumViewerState] = useState<{ images: DownloadableFile[]; currentIndex: number; albumId: string | null } | null>(null)
  const [albumPhotoMetaByPhotoId, setAlbumPhotoMetaByPhotoId] = useState<Record<string, { socialDownloadUrl: string; socialReady: boolean }>>({})
  const [albumSocialEnabledByAlbumId, setAlbumSocialEnabledByAlbumId] = useState<Record<string, boolean>>({})
  const [albumMetaLoadedByAlbumId, setAlbumMetaLoadedByAlbumId] = useState<Record<string, boolean>>({})
  const previewRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())

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

  const splitRootSections = rootVideoGroups.length > 0 && rootAlbumGroups.length > 0

  const openFolder = useMemo(() => {
    if (!openFolderName) return null
    return sortedGroups.find((group) => group.name === openFolderName) || null
  }, [openFolderName, sortedGroups])

  const filesInOpenFolder = useMemo(() => {
    if (!openFolder) return []
    return [...(openFolder.mainFile ? [openFolder.mainFile] : []), ...openFolder.subFiles]
  }, [openFolder])

  useEffect(() => {
    if (!openFolderName) return
    if (!sortedGroups.some((group) => group.name === openFolderName)) {
      setOpenFolderName(null)
    }
  }, [openFolderName, sortedGroups])

  useEffect(() => {
    const requested = String(requestedOpenFolderName || '').trim()
    if (!requested) return

    const matchingGroup = sortedGroups.find((group) => group.name === requested)
    if (matchingGroup) {
      setOpenFolderName(matchingGroup.name)
      return
    }

    setOpenFolderName(null)
  }, [requestedOpenFolderName, sortedGroups])

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
      const next: Record<string, string[]> = {}

      for (const group of sortedGroups) {
        const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
        const imageCandidates = groupFiles
          .filter((file) => getDownloadableFileKind(file) === 'image')
          .slice(0, 12)

        const resolvedUrls = resolveFilePreviewUrl
          ? await Promise.all(
              imageCandidates.map(async (file) => {
                try {
                  const url = await resolveFilePreviewUrl(file)
                  return typeof url === 'string' && url.length > 0 ? url : null
                } catch {
                  return null
                }
              })
            )
          : []

        const uniqueUrls: string[] = []
        for (const url of resolvedUrls) {
          if (!url) continue
          if (uniqueUrls.includes(url)) continue
          uniqueUrls.push(url)
          if (uniqueUrls.length >= 3) break
        }

        if (uniqueUrls.length === 0) {
          const fallback = folderPreviewByName?.[group.name]
          if (typeof fallback === 'string' && fallback.length > 0) {
            uniqueUrls.push(fallback)
          }
        }

        next[group.name] = uniqueUrls
      }

      if (!cancelled) {
        setFolderPreviewTilesByName(next)
      }
    }

    void resolveFolderPreviewTiles()

    return () => {
      cancelled = true
    }
  }, [sortedGroups, resolveFilePreviewUrl, folderPreviewByName])

  useEffect(() => {
    if (!filesInOpenFolder.length) return

    filesInOpenFolder.forEach((file) => {
      const fileKey = getDownloadableFileKey(file)
      if (previewUrlByFileKey[fileKey] !== undefined) return
      const fileKind = getDownloadableFileKind(file)
      if (fileKind !== 'image' && fileKind !== 'video') return

      const embeddedPreview = file.thumbnailUrl || file.previewUrl || null
      if (embeddedPreview) {
        setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: embeddedPreview }))
        return
      }

      const inFlight = previewRequestRef.current.get(fileKey)
      if (inFlight) return

      if (!resolveFilePreviewUrl) return

      const request = resolveFilePreviewUrl(file)
        .then((url) => {
          setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: url || null }))
          return url || null
        })
        .catch(() => {
          setPreviewUrlByFileKey((prev) => ({ ...prev, [fileKey]: null }))
          return null
        })
        .finally(() => {
          previewRequestRef.current.delete(fileKey)
        })

      previewRequestRef.current.set(fileKey, request)
    })
  }, [filesInOpenFolder, previewUrlByFileKey, resolveFilePreviewUrl])

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

    const allFiles = sortedGroups.flatMap((group) => [
      ...(group.mainFile ? [group.mainFile] : []),
      ...group.subFiles,
    ])

    return allFiles.reduce((total, file) => {
      const key = getDownloadableFileKey(file)
      if (!selectedFileIds.has(key)) return total
      const rawSize = typeof file.fileSizeBytes === 'string' ? Number(file.fileSizeBytes) : file.fileSizeBytes
      const size = Number.isFinite(rawSize) && (rawSize as number) > 0 ? Number(rawSize) : 0
      return total + size
    }, 0)
  }, [selectedFileIds, sortedGroups])
  const visibleFiles = openFolder
    ? filesInOpenFolder
    : sortedGroups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])

  useEffect(() => {
    const selectableKeys = new Set(
      visibleFiles
        .filter((file) => isSelectableDownloadableFile(file))
        .map((file) => getDownloadableFileKey(file))
    )

    setSelectedFileIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((key) => selectableKeys.has(key)))
      return next.size === prev.size ? prev : next
    })
  }, [setSelectedFileIds, visibleFiles])

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

  const downloadSelected = async () => {
    const allFiles = sortedGroups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
    const selectedFiles = allFiles.filter((file) => selectedFileIds.has(getDownloadableFileKey(file)))
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

  const isDownloadBusy = isDownloadingSelected || isSharedDownloadActive
  const activeProgress = isSharedDownloadActive ? sharedDownloadProgress : localDownloadProgress

  const openFolderVideoVersions = openFolder?.groupType === 'video'
    ? filesInOpenFolder.filter((file) => file.type === 'video')
    : []
  const openFolderVideoAssets = openFolder?.groupType === 'video'
    ? filesInOpenFolder.filter((file) => file.type === 'asset')
    : []
  const openFolderAlbumZips = openFolder?.groupType === 'album'
    ? filesInOpenFolder.filter((file) => file.type === 'album-zip')
    : []
  const openFolderAlbumPhotos = openFolder?.groupType === 'album'
    ? filesInOpenFolder.filter((file) => file.type === 'album-photo')
    : []
  const videoAssetsSelection = getSubsetSelectionState(openFolderVideoAssets)
  const albumPhotosSelection = getSubsetSelectionState(openFolderAlbumPhotos)

  // Returns the best available full-resolution URL for a file in the lightbox.
  const getLightboxUrl = (file: DownloadableFile): string | null => {
    if (file.type === 'album-photo') {
      // Prefer social-sized preview (higher res than thumbnail)
      return file.previewUrl || file.thumbnailUrl || previewUrlByFileKey[getDownloadableFileKey(file)] || null
    }
    const resolved = previewUrlByFileKey[getDownloadableFileKey(file)]
    return (typeof resolved === 'string' && resolved.length > 0) ? resolved : (file.thumbnailUrl || file.previewUrl || null)
  }

  const openImageLightbox = (file: DownloadableFile, imageList: DownloadableFile[]) => {
    if (getDownloadableFileKind(file) !== 'image') return
    const imageOnly = imageList.filter((f) => getDownloadableFileKind(f) === 'image')
    const index = imageOnly.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
    if (file.type === 'album-photo') {
      const albumPhotoList = imageOnly.filter((f) => f.type === 'album-photo')
      const albumIndex = albumPhotoList.findIndex((f) => getDownloadableFileKey(f) === getDownloadableFileKey(file))
      setAlbumViewerState({
        images: albumPhotoList,
        currentIndex: Math.max(0, albumIndex),
        albumId: typeof file.albumId === 'string' ? file.albumId : null,
      })
      return
    }
    setLightboxState({ images: imageOnly, currentIndex: Math.max(0, index) })
  }

  const lightboxNavigate = (delta: number) => {
    setLightboxState((prev) => {
      if (!prev) return prev
      const next = (prev.currentIndex + delta + prev.images.length) % prev.images.length
      return { ...prev, currentIndex: next }
    })
  }

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

  const loadAlbumPhotoMeta = async (albumId: string | null) => {
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
  }

  useEffect(() => {
    if (!lightboxState) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') lightboxNavigate(-1)
      else if (event.key === 'ArrowRight') lightboxNavigate(1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxState !== null])

  useEffect(() => {
    if (!albumViewerState) return
    void loadAlbumPhotoMeta(albumViewerState.albumId)
  }, [albumViewerState, shareSlug, shareToken])

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
    const requestedKey = String(requestedOpenFileKey || '').trim()
    if (!requestedKey) return
    if (!openFolder) return

    const requestedFile = filesInOpenFolder.find((file) => getDownloadableFileKey(file) === requestedKey)
    if (requestedFile && getDownloadableFileKind(requestedFile) === 'image') {
      const imageList = requestedFile.type === 'album-photo' ? openFolderAlbumPhotos : openFolderVideoAssets
      openImageLightbox(requestedFile, imageList)
    }

    onOpenFileKeyHandled?.()
  }, [
    requestedOpenFileKey,
    openFolder,
    filesInOpenFolder,
    openFolderAlbumPhotos,
    openFolderVideoAssets,
    onOpenFileKeyHandled,
  ])

  const renderOpenFolderFileCard = (file: DownloadableFile, compact = false, imageList: DownloadableFile[] = []) => {
    const fileKey = getDownloadableFileKey(file)
    const FileTypeIcon = getFileTypeIcon(file)
    const fileKind = getDownloadableFileKind(file)
    const isImageFile = fileKind === 'image'
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
    const durationLabel = fileKind === 'video' ? formatDuration(file.durationSeconds) : null
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

    return (
      <div
        key={fileKey}
        className={cn(
          'rounded-xl bg-card transition-colors overflow-hidden shadow-sm',
          isImageFile && 'cursor-zoom-in',
          muteInactiveVideoVersion && 'opacity-55 saturate-0',
          isSelected
            ? 'border-2 border-primary/85 hover:border-primary'
            : 'border border-border hover:border-primary/45'
        )}
        onClick={() => {
          if (muteInactiveVideoVersion) return
          openImageLightbox(file, imageList)
        }}
        onDoubleClick={() => {
          if (muteInactiveVideoVersion) return
          if (file.type === 'video' && file.videoId && onOpenVideoVersion) {
            onOpenVideoVersion(file, openFolder?.name || null)
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
                </div>
              )}

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
            {canDownloadFile ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className={cn('shrink-0', compact ? 'h-6 w-6' : 'h-7 w-7')}
                disabled={muteInactiveVideoVersion}
                onClick={() => void onDownloadFile(file)}
                onClickCapture={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                aria-label={`Download ${file.fileName}`}
                title={`Download ${file.fileName}`}
              >
                <Download className={cn(compact ? 'w-3 h-3' : 'w-3.5 h-3.5')} />
              </Button>
            ) : null}
          </div>
          <div className={cn('text-muted-foreground flex items-center justify-between gap-2', compact ? 'text-[11px] mt-1' : 'text-xs mt-1.5')}>
            <span className="shrink-0">{sizeLabel || 'Size unavailable'}</span>
            {file.type === 'video' ? (
              <span className="min-w-0 truncate text-right" title={file.fileName}>{file.fileName}</span>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  const renderRootFolderCard = (group: DownloadableGroup) => {
    const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
    const groupVideoFiles = groupFiles.filter((file) => file.type === 'video')
    const groupHasApprovedVideo = groupVideoFiles.some((file) => file.isApproved === true)
    const showVideoFolderApprovedBadge = group.groupType === 'video' && groupHasApprovedVideo
    const showVideoFolderForReviewBadge = group.groupType === 'video' && !groupHasApprovedVideo
    const groupFileKeys = groupFiles.map(getDownloadableFileKey)
    const allChecked = groupFileKeys.length > 0 && groupFileKeys.every((key) => selectedFileIds.has(key))
    const someChecked = groupFileKeys.some((key) => selectedFileIds.has(key))
    const folderPreview = folderPreviewByName?.[group.name] || null
    const folderPreviewTiles = folderPreviewTilesByName[group.name] || []
    const leadPreview = folderPreviewTiles[0] || null
    const sidePreviewTop = folderPreviewTiles[1] || null
    const sidePreviewBottom = folderPreviewTiles[2] || null

    return (
      <div
        key={group.name}
        className={cn(
          'rounded-xl bg-card transition-colors overflow-hidden shadow-sm',
          someChecked
            ? 'border-2 border-primary/85 hover:border-primary'
            : 'border border-border hover:border-primary/45'
        )}
        onDoubleClick={() => setOpenFolderName(group.name)}
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
              aria-label={`Select files in ${group.name}`}
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
              <span className="text-sm font-semibold text-foreground truncate">{group.name}</span>
            </div>
            <MoreHorizontal className="w-4 h-4 text-muted-foreground shrink-0" />
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
      <div className="px-4 py-3 border-b border-border flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex items-center justify-between gap-2 sm:flex-1">
          <div className="min-w-0">
            {openFolder ? (
              <div className="flex items-center gap-2 min-w-0">
                <Button type="button" variant="outline" size="sm" className="px-2 sm:px-3" onClick={() => setOpenFolderName(null)}>
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Back</span>
                </Button>
                {selectedCount > 0 ? (
                  <span className="text-xs sm:text-sm text-muted-foreground truncate">
                    {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                  </span>
                ) : null}
              </div>
            ) : (
              selectedCount > 0 ? (
                <span className="text-xs sm:text-sm text-muted-foreground truncate">
                  {selectedCount} file{selectedCount === 1 ? '' : 's'} selected, {formatSelectedTotalSize(selectedTotalSizeBytes)}
                </span>
              ) : (
                <span className="sr-only">Root folder</span>
              )
            )}
          </div>
          {onCloseFilesView ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="h-8 w-8 sm:hidden"
              onClick={onCloseFilesView}
              aria-label="Close files view"
              title="Close files view"
            >
              <X className="w-4 h-4" />
            </Button>
          ) : null}
        </div>
        <div className="flex w-full flex-nowrap items-center gap-2 shrink-0 sm:ml-auto sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-[30] min-w-0 sm:flex-none sm:w-auto"
            onClick={selectAllVisible}
            disabled={visibleFiles.length === 0}
          >
            Select All
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-[25] min-w-0 sm:flex-none sm:w-auto"
            onClick={() => setSelectedFileIds(new Set())}
            disabled={selectedCount === 0}
          >
            Clear
          </Button>
          <Button
            type="button"
            size="sm"
            className="flex-[45] min-w-0 sm:flex-none sm:w-auto"
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
              className="hidden h-8 w-8 sm:inline-flex"
              onClick={onCloseFilesView}
              aria-label="Close files view"
              title="Close files view"
            >
              <X className="w-4 h-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-0">
        {!openFolder ? (
          <div className={cn(splitRootSections ? 'space-y-5' : 'space-y-2')}>
            <h4 className="px-1 text-base sm:text-lg font-bold uppercase tracking-wider text-white truncate" title={rootFolderLabel || 'PROJECT'}>
              {rootFolderLabel || 'PROJECT'}
            </h4>
            {splitRootSections ? (
              <>
                <section className="space-y-2">
                  <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Videos</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {rootVideoGroups.map((group) => renderRootFolderCard(group))}
                  </div>
                </section>

                <section className="space-y-2 border-t border-border/70 pt-4">
                  <h4 className="px-1 text-base sm:text-lg font-bold tracking-wider text-white">Albums</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {rootAlbumGroups.map((group) => renderRootFolderCard(group))}
                  </div>
                </section>
              </>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
                {sortedGroups.map((group) => renderRootFolderCard(group))}
              </div>
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
                  </div>
                  {openFolderVideoAssets.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5">
                      {openFolderVideoAssets.map((file) => renderOpenFolderFileCard(file, true, openFolderVideoAssets))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">There are currently no Video Assets for this video.</p>
                  )}
                </section>
              </>
            ) : (
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
                  </div>
                  {openFolderAlbumPhotos.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 gap-2.5">
                      {openFolderAlbumPhotos.map((file) => renderOpenFolderFileCard(file, true, openFolderAlbumPhotos))}
                    </div>
                  ) : (
                    <p className="px-1 text-xs text-muted-foreground italic">No photos available.</p>
                  )}
                </section>
              </>
            )}
          </div>
        )}

        {sortedGroups.length === 0 && (
          <div className={cn('h-full min-h-[180px] flex items-center justify-center text-sm text-muted-foreground')}>
            No files available.
          </div>
        )}
      </div>

      {(() => {
        const lightboxFile = lightboxState ? lightboxState.images[lightboxState.currentIndex] : null
        const lightboxSrc = lightboxFile ? getLightboxUrl(lightboxFile) : null
        const hasMultiple = lightboxState && lightboxState.images.length > 1
        return (
          <Dialog open={Boolean(lightboxState)} onOpenChange={(open) => { if (!open) setLightboxState(null) }}>
            <DialogContent className="max-w-[92vw] sm:max-w-5xl p-0 overflow-hidden bg-black border-border">
              {lightboxFile && lightboxSrc ? (
                <div className="relative w-full h-[70vh] bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={lightboxSrc}
                    alt={lightboxFile.fileName}
                    className="w-full h-full object-contain"
                  />
                  {hasMultiple ? (
                    <>
                      <button
                        type="button"
                        onClick={() => lightboxNavigate(-1)}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Previous image"
                      >
                        <ChevronLeft className="w-6 h-6" />
                      </button>
                      <button
                        type="button"
                        onClick={() => lightboxNavigate(1)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 hover:bg-black/85 p-1.5 text-white transition-colors"
                        aria-label="Next image"
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
                    <p className="text-sm text-muted-foreground">
                      This is a low resolution preview. Use the buttons to download the original versions.
                    </p>
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
