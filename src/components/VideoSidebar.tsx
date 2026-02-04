'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { Play, ChevronDown, ChevronUp, GripVertical, CheckCircle2, Images, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import Image from 'next/image'

interface VideoGroup {
  name: string
  videos: any[]
  versionCount: number
}

interface VideoSidebarProps {
  videosByName: Record<string, any[]>
  activeVideoName: string
  onVideoSelect: (videoName: string) => void
  albums?: Array<{ id: string; name: string; photoCount?: number; previewPhotoUrl?: string | null }>
  activeAlbumId?: string | null
  onAlbumSelect?: (albumId: string) => void
  heading?: string
  showVideos?: boolean
  showAlbums?: boolean
  hideApprovalGrouping?: boolean
  className?: string
  initialCollapsed?: boolean
}

// Helper function to calculate thumbnail dimensions maintaining aspect ratio within 16:9
const calculateThumbnailDimensions = (
  videoWidth: number | null,
  videoHeight: number | null,
  containerWidth: number,
  containerHeight: number = Math.round(containerWidth * 9 / 16)
): { width: number; height: number; top: number; left: number } => {
  // Default to 16:9 if dimensions not available
  const vidWidth = videoWidth || 16
  const vidHeight = videoHeight || 9

  const videoAspectRatio = vidWidth / vidHeight
  const containerAspectRatio = containerWidth / containerHeight

  let finalWidth: number
  let finalHeight: number

  // If video is wider than container, constrain by width
  if (videoAspectRatio > containerAspectRatio) {
    finalWidth = containerWidth
    finalHeight = Math.round(containerWidth / videoAspectRatio)
  } else {
    // If video is taller than container, constrain by height
    finalHeight = containerHeight
    finalWidth = Math.round(containerHeight * videoAspectRatio)
  }

  // Center the thumbnail within the container
  const top = Math.round((containerHeight - finalHeight) / 2)
  const left = Math.round((containerWidth - finalWidth) / 2)

  return { width: finalWidth, height: finalHeight, top, left }
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
}: VideoSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(256) // Default 256px (w-64)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const [thumbnailDimensions, setThumbnailDimensions] = useState<Record<string, any>>({})

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

  // Calculate thumbnail dimensions when sidebar width changes
  useEffect(() => {
    const dims: Record<string, any> = {}
    // Account for: nav padding (12px left + 12px right) + button padding (12px left + 12px right) = 48px
    const containerWidth = sidebarWidth - 48
    const containerHeight = Math.round(containerWidth * 9 / 16)

    for (const [videoName, videos] of Object.entries(videosByName || {})) {
      const latestVideo = videos[0]
      if (latestVideo) {
        dims[videoName] = calculateThumbnailDimensions(
          latestVideo.width || latestVideo.videoWidth,
          latestVideo.height || latestVideo.videoHeight,
          containerWidth,
          containerHeight
        )
      }
    }
    setThumbnailDimensions(dims)
  }, [sidebarWidth, videosByName])

  // Handle mouse move for resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return

      const newWidth = e.clientX
      const minWidth = 200
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

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
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
        <div className="flex-1 min-h-0 max-h-full overflow-y-auto overflow-x-hidden sidebar-scrollbar">
          {heading && (
            <div className="p-4 border-b border-border">
              <h2 className="text-base font-semibold text-foreground truncate" title={heading}>
                {heading}
              </h2>
            </div>
          )}

          <nav className="p-3">
          {(() => {
            // Split videos into For Review and Approved groups.
            // Note: on some share modes (e.g. guest), approval flags may be hidden; allow callers to disable grouping.
            const forReview = sortedVideoGroups(videoGroups.filter(g => !g.videos.some((v: any) => v.approved === true)))
            const approved = sortedVideoGroups(videoGroups.filter(g => g.videos.some((v: any) => v.approved === true)))
            const flatAlphabetical = sortedVideoGroups(videoGroups)

            const renderVideoButton = (group: VideoGroup) => {
              const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
              const isActive = !activeAlbumId && activeVideoName === group.name
              const latestVideo = group.videos[0]
              const thumbnailUrl = latestVideo?.thumbnailUrl
              const dims = thumbnailDimensions[group.name]
              const containerWidth = sidebarWidth - 48 // Account for nav + button padding
              const containerHeight = Math.round(containerWidth * 9 / 16)

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
                  {/* Thumbnail */}
                  {thumbnailUrl && dims && (
                    <div
                      className="bg-black rounded overflow-hidden flex items-center justify-center"
                      style={{
                        width: containerWidth,
                        height: containerHeight,
                      }}
                    >
                      <div
                        className="relative"
                        style={{
                          width: dims.width,
                          height: dims.height,
                        }}
                      >
                        <Image
                          src={thumbnailUrl}
                          alt={group.name}
                          fill
                          className="object-cover"
                          sizes={`${containerWidth}px`}
                          priority={isActive}
                        />
                      </div>
                    </div>
                  )}

                  {/* Video Info */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug line-clamp-2 break-words">{group.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {group.versionCount} {group.versionCount === 1 ? 'version' : 'versions'}
                        </p>
                      </div>
                    </div>
                    {isActive && (
                      hasApprovedVideo ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
                      ) : (
                        <Play className="w-4 h-4 shrink-0 text-primary" fill="currentColor" />
                      )
                    )}
                  </div>
                </button>
              )
            }

            return (
              <>
                {hideApprovalGrouping && flatAlphabetical.length > 0 && (
                  <div className="space-y-1 mb-4">
                    {flatAlphabetical.map(renderVideoButton)}
                  </div>
                )}

                {!hideApprovalGrouping && forReview.length > 0 && (
                  <>
                    <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      For Review
                    </div>
                    <div className="space-y-1 mb-4">
                      {forReview.map(renderVideoButton)}
                    </div>
                  </>
                )}

                {!hideApprovalGrouping && approved.length > 0 && (
                  <>
                    {forReview.length > 0 && (
                      <div className="border-t border-border my-3" />
                    )}
                    <div className="px-3 py-2 text-xs font-semibold text-success uppercase tracking-wider flex items-center gap-2">
                      <CheckCircle2 className="w-3 h-3" />
                      Approved
                    </div>
                    <div className="space-y-1">
                      {approved.map(renderVideoButton)}
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
                      {albumsList.map((a) => {
                        const isActive = activeAlbumId === a.id
                        const previewUrl = (a as any)?.previewPhotoUrl as string | null | undefined
                        const containerWidth = sidebarWidth - 48
                        const containerHeight = Math.round(containerWidth * 9 / 16)
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
                            {previewUrl ? (
                              <div
                                className="bg-black rounded overflow-hidden relative"
                                style={{ width: containerWidth, height: containerHeight }}
                              >
                                <Image
                                  src={previewUrl}
                                  alt={a.name}
                                  fill
                                  className="object-cover"
                                  sizes={`${containerWidth}px`}
                                  priority={isActive}
                                />
                              </div>
                            ) : (
                              <div
                                className="bg-gradient-to-br from-muted to-muted-foreground rounded flex items-center justify-center"
                                style={{ width: containerWidth, height: containerHeight }}
                              >
                                <Images className="w-6 h-6 text-muted-foreground" />
                              </div>
                            )}

                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm leading-snug line-clamp-2 break-words">{a.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
                                </p>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </>
            )
          })()}
          </nav>
        </div>

        {/* Resize Handle */}
        <div
          onMouseDown={handleMouseDown}
          className={cn(
            'absolute right-0 top-0 bottom-0 w-1 cursor-col-resize',
            'hover:bg-primary transition-colors',
            'group'
          )}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 -translate-x-1/2">
            <GripVertical className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
      </aside>

      {/* Mobile Horizontal Scrollable Row */}
      <div className="lg:hidden">
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-accent/30">
            {shouldShowVideos && videoGroups.length > 0 && shouldShowAlbums && albumsList.length > 0
              ? 'Videos & Albums'
              : shouldShowVideos && videoGroups.length > 0
              ? 'Videos'
              : 'Albums'}
          </div>
          <div className="overflow-x-auto mobile-scrollbar">
            <div className="flex gap-3 p-3">
              {/* Videos */}
              {shouldShowVideos && sortedVideoGroups(videoGroups).map((group) => {
                const isActive = !activeAlbumId && activeVideoName === group.name
                const latestVideo = group.videos[0]
                const thumbnailUrl = latestVideo?.thumbnailUrl
                const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
                const mobileThumbSize = 100
                const mobileThumbHeight = Math.round(mobileThumbSize * 9 / 16)
                const latestVideoDims = calculateThumbnailDimensions(
                  latestVideo?.width || latestVideo?.videoWidth,
                  latestVideo?.height || latestVideo?.videoHeight,
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
                            className="object-cover"
                            sizes={`${mobileThumbSize}px`}
                            priority={isActive}
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
                        {group.versionCount} {group.versionCount === 1 ? 'version' : 'versions'}
                      </p>
                    </div>
                  </button>
                )
              })}

              {/* Albums */}
              {shouldShowAlbums && albumsList.map((a) => {
                const isActive = activeAlbumId === a.id
                const previewUrl = (a as any)?.previewPhotoUrl as string | null | undefined
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
                        <Image
                          src={previewUrl}
                          alt={a.name}
                          fill
                          className="object-cover"
                          sizes={`${mobileThumbSize}px`}
                          priority={isActive}
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
        </div>
      </div>

      <style jsx global>{`
        /* Discreet desktop sidebar scrollbar */
        .sidebar-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .sidebar-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .sidebar-scrollbar::-webkit-scrollbar-thumb {
          background: hsl(var(--muted-foreground) / 0.2);
          border-radius: 3px;
        }
        .sidebar-scrollbar::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--muted-foreground) / 0.3);
        }
        .sidebar-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: hsl(var(--muted-foreground) / 0.2) transparent;
        }

        /* Discreet mobile horizontal scrollbar */
        .mobile-scrollbar::-webkit-scrollbar {
          height: 6px;
        }
        .mobile-scrollbar::-webkit-scrollbar-track {
          background: hsl(var(--accent));
        }
        .mobile-scrollbar::-webkit-scrollbar-thumb {
          background: hsl(var(--muted-foreground) / 0.3);
          border-radius: 3px;
        }
        .mobile-scrollbar::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--muted-foreground) / 0.4);
        }
        .mobile-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: hsl(var(--muted-foreground) / 0.3) hsl(var(--accent));
        }
      `}</style>
    </>
  )
}
