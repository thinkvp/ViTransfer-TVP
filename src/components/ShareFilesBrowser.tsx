'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import {
  ArrowLeft,
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

type ShareFilesBrowserProps = {
  groups: DownloadableGroup[]
  selectedFileIds: Set<string>
  setSelectedFileIds: React.Dispatch<React.SetStateAction<Set<string>>>
  onDownloadFile: (file: DownloadableFile) => Promise<void>
  onDownloadFiles?: (files: DownloadableFile[], onProgress?: (pct: number) => void) => Promise<void>
  onCloseFilesView?: () => void
  requestedOpenFolderName?: string | null
  folderPreviewByName?: Record<string, string | null>
  resolveFilePreviewUrl?: (file: DownloadableFile) => Promise<string | null>
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

export function ShareFilesBrowser({
  groups,
  selectedFileIds,
  setSelectedFileIds,
  onDownloadFile,
  onDownloadFiles,
  onCloseFilesView,
  requestedOpenFolderName,
  folderPreviewByName,
  resolveFilePreviewUrl,
}: ShareFilesBrowserProps) {
  const [openFolderName, setOpenFolderName] = useState<string | null>(null)
  const [isDownloadingSelected, setIsDownloadingSelected] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [previewUrlByFileKey, setPreviewUrlByFileKey] = useState<Record<string, string | null>>({})
  const [folderPreviewTilesByName, setFolderPreviewTilesByName] = useState<Record<string, string[]>>({})
  const previewRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [groups])

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
    }
  }, [requestedOpenFolderName, sortedGroups])

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
    if (!resolveFilePreviewUrl || !filesInOpenFolder.length) return

    filesInOpenFolder.forEach((file) => {
      const fileKey = getDownloadableFileKey(file)
      if (previewUrlByFileKey[fileKey] !== undefined) return
      if (getDownloadableFileKind(file) !== 'image') return

      const inFlight = previewRequestRef.current.get(fileKey)
      if (inFlight) return

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
    const fileKeys = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles].map(getDownloadableFileKey)
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

  const selectedCount = selectedFileIds.size
  const visibleFiles = openFolder
    ? filesInOpenFolder
    : sortedGroups.flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])

  const selectAllVisible = () => {
    const visibleKeys = visibleFiles.map(getDownloadableFileKey)
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
    if (!selectedFiles.length) return

    setIsDownloadingSelected(true)
    setDownloadProgress(null)
    try {
      if (onDownloadFiles) {
        await onDownloadFiles(selectedFiles, (pct) => setDownloadProgress(pct))
      } else {
        await Promise.all(selectedFiles.map((file) => onDownloadFile(file).catch(() => undefined)))
      }
    } finally {
      setIsDownloadingSelected(false)
      setDownloadProgress(null)
    }
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
                <span className="text-sm text-muted-foreground">/</span>
                <span className="text-sm font-semibold text-foreground truncate">{openFolder.name}</span>
              </div>
            ) : (
              <h3 className="text-sm font-semibold text-foreground">Files</h3>
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
            disabled={selectedCount === 0 || isDownloadingSelected}
          >
            <Download className="w-4 h-4" />
            {isDownloadingSelected
              ? downloadProgress !== null
                ? `Zipping… ${Math.round(downloadProgress)}%`
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

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {!openFolder ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
            {sortedGroups.map((group) => {
              const groupFiles = [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles]
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
                  className="rounded-xl border border-border/80 bg-card hover:border-primary/40 transition-colors overflow-hidden shadow-sm"
                  onDoubleClick={() => setOpenFolderName(group.name)}
                >
                  <div className="relative p-3 pb-2 bg-gradient-to-b from-muted/65 to-muted/30">
                    <div className="absolute left-4 top-1 h-2.5 w-20 rounded-t-md border border-b-0 border-border/70 bg-muted" />
                    <div className="relative rounded-lg border border-border/70 bg-card/70 p-1.5 shadow-inner">
                      <div className="grid grid-cols-3 grid-rows-2 gap-1.5 aspect-[4/3] rounded-md overflow-hidden bg-black/5">
                        {leadPreview ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={leadPreview}
                              alt={group.name}
                              className="col-span-2 row-span-2 h-full w-full object-cover"
                              loading="lazy"
                            />

                            {sidePreviewTop ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sidePreviewTop}
                                alt=""
                                aria-hidden="true"
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="h-full w-full bg-muted/35" aria-hidden="true" />
                            )}

                            {sidePreviewBottom ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={sidePreviewBottom}
                                alt=""
                                aria-hidden="true"
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="h-full w-full bg-muted/20" aria-hidden="true" />
                            )}
                          </>
                        ) : folderPreview ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={folderPreview}
                              alt={group.name}
                              className="col-span-2 row-span-2 h-full w-full object-cover"
                              loading="lazy"
                            />
                            <div className="h-full w-full bg-muted/35" aria-hidden="true" />
                            <div className="h-full w-full bg-muted/20" aria-hidden="true" />
                          </>
                        ) : (
                          <div className="col-span-3 row-span-2 h-full w-full flex items-center justify-center text-muted-foreground">
                            <Folder className="w-10 h-10" />
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="absolute top-2 left-2">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = someChecked && !allChecked
                        }}
                        onChange={(event) => toggleGroup(group, event.target.checked)}
                        className="w-4 h-4 rounded accent-primary"
                        aria-label={`Select files in ${group.name}`}
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setOpenFolderName(group.name)}
                    className="w-full text-left px-3 py-3"
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
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
            {filesInOpenFolder.map((file) => {
              const fileKey = getDownloadableFileKey(file)
              const FileTypeIcon = getFileTypeIcon(file)
              const fileKind = getDownloadableFileKind(file)
              const isSelected = selectedFileIds.has(fileKey)
              const resolvedPreview = previewUrlByFileKey[fileKey]
              const showImagePreview = typeof resolvedPreview === 'string' && resolvedPreview.length > 0
              const showVideoPreview = file.type === 'video' && Boolean(folderPreviewByName?.[openFolder.name])
              const sizeLabel = formatFileSize(file.fileSizeBytes)
              const durationLabel = fileKind === 'video' ? formatDuration(file.durationSeconds) : null
              const fileExtensionLabel = getFileExtensionLabel(file.fileName)

              return (
                <div
                  key={fileKey}
                  className="rounded-xl border border-border/80 bg-card hover:border-primary/40 transition-colors overflow-hidden shadow-sm"
                  onDoubleClick={() => void onDownloadFile(file)}
                >
                  <div className="relative p-3 pb-2 bg-gradient-to-b from-muted/65 to-muted/30">
                    <div className="absolute left-4 top-1 h-2.5 w-20 rounded-t-md border border-b-0 border-border/70 bg-muted" />
                    <div className="relative rounded-lg border border-border/70 bg-card/70 p-1.5 shadow-inner">
                      <div className="relative aspect-[4/3] rounded-md overflow-hidden bg-black/5">
                        {showImagePreview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={resolvedPreview!} alt={file.fileName} className="w-full h-full object-cover" loading="lazy" />
                        ) : showVideoPreview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={folderPreviewByName?.[openFolder.name] || ''}
                            alt={file.fileName}
                            className="w-full h-full object-cover"
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
                      </div>

                      <div className="absolute top-2 left-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => toggleFile(fileKey, event.target.checked)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="w-4 h-4 rounded accent-primary"
                          aria-label={`Select ${file.fileName}`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="px-3 py-3">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileTypeIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                        <p className="text-sm font-semibold text-foreground truncate" title={file.fileName}>{file.fileName}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={() => void onDownloadFile(file)}
                        onDoubleClick={(event) => event.stopPropagation()}
                        aria-label={`Download ${file.fileName}`}
                        title={`Download ${file.fileName}`}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {sizeLabel || 'Size unavailable'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {sortedGroups.length === 0 && (
          <div className={cn('h-full min-h-[180px] flex items-center justify-center text-sm text-muted-foreground')}>
            No files available.
          </div>
        )}
      </div>
    </div>
  )
}
