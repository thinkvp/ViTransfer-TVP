'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { Play, ChevronDown, ChevronUp, GripVertical, CheckCircle2, Images } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VideoGroup {
  name: string
  videos: any[]
  versionCount: number
}

interface VideoSidebarProps {
  videosByName: Record<string, any[]>
  activeVideoName: string
  onVideoSelect: (videoName: string) => void
  albums?: Array<{ id: string; name: string; photoCount?: number }>
  activeAlbumId?: string | null
  onAlbumSelect?: (albumId: string) => void
  heading?: string
  showVideos?: boolean
  showAlbums?: boolean
  className?: string
  initialCollapsed?: boolean
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
  className,
  initialCollapsed = true,
}: VideoSidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(256) // Default 256px (w-64)
  const [isResizing, setIsResizing] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)

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

  const hasExplicitHeightClass = /\b(?:h|max-h)-/.test(className ?? '')

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
          'hidden lg:block bg-card border border-border relative rounded-lg',
          'overflow-y-auto self-stretch min-h-0',
          // Default to full viewport height (minus admin header), but allow override via className
          !hasExplicitHeightClass && 'h-[calc(100dvh-var(--admin-header-height,0px))]',
          className
        )}
      >
        {heading && (
          <div className="p-4 border-b border-border">
            <h2 className="text-base font-semibold text-foreground truncate" title={heading}>
              {heading}
            </h2>
          </div>
        )}

        <nav className="p-3">
          {(() => {
            // Split videos into For Review and Approved groups
            const forReview = sortedVideoGroups(videoGroups.filter(g => !g.videos.some((v: any) => v.approved === true)))
            const approved = sortedVideoGroups(videoGroups.filter(g => g.videos.some((v: any) => v.approved === true)))

            const renderVideoButton = (group: VideoGroup) => {
              const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
              const isActive = !activeAlbumId && activeVideoName === group.name
              return (
                <button
                  key={group.name}
                  onClick={() => onVideoSelect(group.name)}
                  className={cn(
                    'w-full text-left p-3 rounded-lg transition-all duration-200',
                    'hover:bg-accent hover:text-accent-foreground',
                    'flex items-center justify-between gap-3',
                    isActive
                      ? 'bg-primary/10 text-primary font-medium border border-primary/20'
                      : 'text-foreground'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={cn(
                        'w-2 h-2 rounded-full shrink-0',
                        isActive ? 'bg-primary' : 'bg-muted-foreground'
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{group.name}</p>
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
                </button>
              )
            }

            return (
              <>
                {forReview.length > 0 && (
                  <>
                    <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      For Review
                    </div>
                    <div className="space-y-1 mb-4">
                      {forReview.map(renderVideoButton)}
                    </div>
                  </>
                )}

                {approved.length > 0 && (
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
                        return (
                          <button
                            key={a.id}
                            onClick={() => onAlbumSelect?.(a.id)}
                            className={cn(
                              'w-full text-left p-3 rounded-lg transition-all duration-200',
                              'hover:bg-accent hover:text-accent-foreground',
                              'flex items-center justify-between gap-3',
                              isActive
                                ? 'bg-primary/10 text-primary font-medium border border-primary/20'
                                : 'text-foreground'
                            )}
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div
                                className={cn(
                                  'w-2 h-2 rounded-full shrink-0',
                                  isActive ? 'bg-primary' : 'bg-muted-foreground'
                                )}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">{a.name}</p>
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

      {/* Mobile Dropdown */}
      <div className="lg:hidden mb-4 bg-card border border-border rounded-lg overflow-hidden">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-accent transition-colors"
        >
          <div className="flex-1 min-w-0 flex items-center gap-4">
            <div className="w-24 flex-shrink-0">
              <p className="text-xs text-muted-foreground leading-tight text-right">
                {isCollapsed ? (
                  <>
                    Tap to<br />
                    select {activeAlbum || !shouldShowVideos ? 'album' : 'video'}
                  </>
                ) : (
                  <>
                    Currently<br />
                    viewing
                  </>
                )}
              </p>
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground truncate">
                {activeAlbum ? activeAlbum.name : (activeVideoName || 'Select')}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {activeAlbum
                  ? `${activeAlbum.photoCount ?? 0} photo${(activeAlbum.photoCount ?? 0) === 1 ? '' : 's'}`
                  : `${videoGroups.find(g => g.name === activeVideoName)?.versionCount || 0} versions`
                }
              </p>
            </div>
          </div>
          {isCollapsed ? (
            <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0 ml-3" />
          ) : (
            <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0 ml-3" />
          )}
        </button>

        {!isCollapsed && (
          <div className="border-t border-border">
            {(() => {
              // Split videos into For Review and Approved groups
              const forReview = sortedVideoGroups(videoGroups.filter(g => !g.videos.some((v: any) => v.approved === true)))
              const approved = sortedVideoGroups(videoGroups.filter(g => g.videos.some((v: any) => v.approved === true)))

              const renderVideoButton = (group: VideoGroup, isLast: boolean) => {
                const hasApprovedVideo = group.videos.some((v: any) => v.approved === true)
                const isActive = !activeAlbumId && activeVideoName === group.name
                return (
                  <button
                    key={group.name}
                    onClick={() => {
                      onVideoSelect(group.name)
                      setIsCollapsed(true) // Auto-collapse after selection to show video player
                    }}
                    className={cn(
                      'w-full text-left p-4 transition-colors',
                      'hover:bg-accent',
                      'flex items-center justify-between gap-3',
                      'border-b border-border',
                      isLast && approved.length === 0 && 'last:border-b-0',
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground'
                    )}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                        className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          isActive ? 'bg-primary' : 'bg-muted-foreground'
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{group.name}</p>
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
                  </button>
                )
              }

              return (
                <>
                  {shouldShowVideos && forReview.length > 0 && (
                    <>
                      <div className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-accent/30">
                        For Review
                      </div>
                      {forReview.map((group, index) => renderVideoButton(group, index === forReview.length - 1))}
                    </>
                  )}

                  {shouldShowVideos && approved.length > 0 && (
                    <>
                      <div className="px-4 py-3 text-xs font-semibold text-success uppercase tracking-wider bg-success-visible flex items-center gap-2">
                        <CheckCircle2 className="w-3 h-3" />
                        Approved
                      </div>
                      {approved.map((group, index) => (
                        <button
                          key={group.name}
                          onClick={() => {
                            onVideoSelect(group.name)
                            setIsCollapsed(true) // Auto-collapse after selection to show video player
                          }}
                          className={cn(
                            'w-full text-left p-4 transition-colors',
                            'hover:bg-accent',
                            'flex items-center justify-between gap-3',
                            'border-b border-border',
                            index === approved.length - 1 && 'last:border-b-0',
                            !activeAlbumId && activeVideoName === group.name
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'text-foreground'
                          )}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div
                              className={cn(
                                'w-2 h-2 rounded-full shrink-0',
                                !activeAlbumId && activeVideoName === group.name ? 'bg-primary' : 'bg-muted-foreground'
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{group.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {group.versionCount} {group.versionCount === 1 ? 'version' : 'versions'}
                              </p>
                            </div>
                          </div>
                          {!activeAlbumId && activeVideoName === group.name && (
                            <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
                          )}
                        </button>
                      ))}
                    </>
                  )}

                  {albumsList.length > 0 && (
                    <>
                      <div className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-accent/30 flex items-center gap-2">
                        <Images className="w-3 h-3" />
                        Albums
                      </div>
                      {albumsList.map((a, index) => (
                        <button
                          key={a.id}
                          onClick={() => {
                            onAlbumSelect?.(a.id)
                            setIsCollapsed(true)
                          }}
                          className={cn(
                            'w-full text-left p-4 transition-colors',
                            'hover:bg-accent',
                            'flex items-center justify-between gap-3',
                            'border-b border-border',
                            index === albumsList.length - 1 && 'last:border-b-0',
                            activeAlbumId === a.id
                              ? 'bg-primary/10 text-primary font-medium'
                              : 'text-foreground'
                          )}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div
                              className={cn(
                                'w-2 h-2 rounded-full shrink-0',
                                activeAlbumId === a.id ? 'bg-primary' : 'bg-muted-foreground'
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{a.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
                              </p>
                            </div>
                          </div>
                        </button>
                      ))}
                    </>
                  )}

                  {shouldShowAlbums && (
                    <>
                      <div className="px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider bg-accent/30 flex items-center gap-2">
                        <Images className="w-3 h-3" />
                        Albums
                      </div>
                      {albumsList.map((a, index) => {
                        const isLast = index === albumsList.length - 1
                        const isActive = activeAlbumId === a.id
                        return (
                          <button
                            key={a.id}
                            onClick={() => {
                              onAlbumSelect?.(a.id)
                              setIsCollapsed(true)
                            }}
                            className={cn(
                              'w-full text-left p-4 transition-colors',
                              'hover:bg-accent',
                              'flex items-center justify-between gap-3',
                              'border-b border-border',
                              isLast && 'last:border-b-0',
                              isActive
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-foreground'
                            )}
                          >
                            <div className="flex items-center gap-3 min-w-0 flex-1">
                              <div
                                className={cn(
                                  'w-2 h-2 rounded-full shrink-0',
                                  isActive ? 'bg-primary' : 'bg-muted-foreground'
                                )}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">{a.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {a.photoCount ?? 0} photo{(a.photoCount ?? 0) === 1 ? '' : 's'}
                                </p>
                              </div>
                            </div>
                          </button>
                        )
                      })}
                    </>
                  )}
                </>
              )
            })()}
          </div>
        )}
      </div>
    </>
  )
}
