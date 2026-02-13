'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import VideoPlayer from '@/components/VideoPlayer'
import CommentInput from '@/components/CommentInput'
import { CommentSectionView } from '@/components/CommentSection'
import { GripVertical } from 'lucide-react'
import VideoSidebar from '@/components/VideoSidebar'
import { ShareAlbumViewer } from '@/components/ShareAlbumViewer'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { cn } from '@/lib/utils'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'

export default function AdminSharePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const id = params?.id as string

  // Parse URL parameters for video seeking (same as public share page)
  const urlTimestamp = searchParams?.get('t') ? parseInt(searchParams.get('t')!, 10) : null
  const urlVideoName = searchParams?.get('video') || null
  const urlVersion = searchParams?.get('version') ? parseInt(searchParams.get('version')!, 10) : null

  const [project, setProject] = useState<any>(null)
  const [comments, setComments] = useState<any[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p'>('720p')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [allVideosByName, setAllVideosByName] = useState<Record<string, any[]>>({})
  const [tokensLoading, setTokensLoading] = useState(false)
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [adminUser, setAdminUser] = useState<any>(null)
  const [albums, setAlbums] = useState<any[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(false)
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null)
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const sessionIdRef = useRef<string>(`admin:${Date.now()}`)

  // Fetch comments separately for security (same pattern as public share)
  const fetchComments = useCallback(async () => {
    if (!id) return

    setCommentsLoading(true)
    try {
      const response = await apiFetch(`/api/comments?projectId=${id}`)
      if (response.ok) {
        const commentsData = await response.json()
        setComments(commentsData)
      }
    } catch (error) {
      // Failed to load comments
    } finally {
      setCommentsLoading(false)
    }
  }, [id])

  const transformProjectData = (projectData: any) => {
    const videosByName = projectData.videos.reduce((acc: any, video: any) => {
      const name = video.name
      if (!acc[name]) {
        acc[name] = []
      }
      acc[name].push(video)
      return acc
    }, {})

    // Sort versions within each video name (newest first)
    Object.keys(videosByName).forEach(name => {
      videosByName[name].sort((a: any, b: any) => b.version - a.version)
    })

    return {
      ...projectData,
      videosByName
    }
  }

  const fetchTokensForVideos = useCallback(async (videos: any[]) => {
    const sessionId = sessionIdRef.current
    const shouldFetchTimelinePreviews = !!project?.timelinePreviewsEnabled
    const isWatermarkEnabled = project?.watermarkEnabled === true

    return Promise.all(
      videos.map(async (video: any) => {
        const cached = tokenCacheRef.current.get(video.id)
        if (cached) {
          return cached
        }

        try {
          const [response720p, response1080p] = await Promise.all([
            apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=720p&sessionId=${sessionId}`),
            apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=1080p&sessionId=${sessionId}`)
          ])

          let streamToken720p = ''
          let streamToken1080p = ''
          let downloadToken = null

          if (response720p.ok) {
            const data720p = await response720p.json()
            streamToken720p = data720p.token
          }

          if (response1080p.ok) {
            const data1080p = await response1080p.json()
            streamToken1080p = data1080p.token
          }

          if (video.approved) {
            const shouldStreamOriginal = isWatermarkEnabled
            const responseOriginal = await apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=original&sessionId=${sessionId}`)
            if (responseOriginal.ok) {
              const dataOriginal = await responseOriginal.json()
              downloadToken = dataOriginal.token

              if (shouldStreamOriginal) {
                streamToken720p = dataOriginal.token
                streamToken1080p = dataOriginal.token
              } else {
                streamToken720p = streamToken720p || dataOriginal.token
                streamToken1080p = streamToken1080p || dataOriginal.token
              }
            }
          }

          let thumbnailUrl = null
          if (video.thumbnailPath) {
            const responseThumbnail = await apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=thumbnail&sessionId=${sessionId}`)
            if (responseThumbnail.ok) {
              const dataThumbnail = await responseThumbnail.json()
              thumbnailUrl = `/api/content/${dataThumbnail.token}`
            }
          }

          let timelineVttUrl = null
          let timelineSpriteUrl = null
          if (shouldFetchTimelinePreviews && video.timelinePreviewsReady) {
            const [responseVtt, responseSprite] = await Promise.all([
              apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=timeline-vtt&sessionId=${sessionId}`),
              apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=timeline-sprite&sessionId=${sessionId}`),
            ])
            if (responseVtt.ok) {
              const dataVtt = await responseVtt.json()
              timelineVttUrl = dataVtt.token ? `/api/content/${dataVtt.token}` : null
            }
            if (responseSprite.ok) {
              const dataSprite = await responseSprite.json()
              timelineSpriteUrl = dataSprite.token ? `/api/content/${dataSprite.token}` : null
            }
          }

          const tokenized = {
            ...video,
            streamUrl720p: streamToken720p ? `/api/content/${streamToken720p}` : '',
            streamUrl1080p: streamToken1080p ? `/api/content/${streamToken1080p}` : '',
            downloadUrl: downloadToken ? `/api/content/${downloadToken}?download=true` : null,
            thumbnailUrl,
            timelineVttUrl,
            timelineSpriteUrl,
          }

          tokenCacheRef.current.set(video.id, tokenized)
          return tokenized
        } catch (error) {
          return video
        }
      })
    )
  }, [id, project])

  // Load project data, settings, and admin user
  useEffect(() => {
    let isMounted = true

    async function loadProject() {
      if (!id) {
        setLoading(false)
        return
      }
      try {
        // Fetch project, settings, and current user in parallel
        const [projectResponse, userResponse, settingsResponse] = await Promise.all([
          apiFetch(`/api/projects/${id}`),
          apiFetch('/api/auth/session'),
          apiFetch('/api/settings'),
        ])

        if (!isMounted) return

        if (projectResponse.ok) {
          const projectData = await projectResponse.json()

          if (userResponse.ok) {
            const userData = await userResponse.json()
            setAdminUser(userData.user)
          }

          if (settingsResponse.ok) {
            const settingsData = await settingsResponse.json()
            setCompanyName(settingsData.companyName || 'Studio')
          } else {
            setCompanyName(projectData.companyName || 'Studio')
          }

          if (isMounted) {
            const transformedData = transformProjectData(projectData)
            setProject(transformedData)

            // Use project/company fallback for studio name and preview quality
            setDefaultQuality(projectData.previewResolution || '720p')

            if (!(projectData.hideFeedback || projectData.status === 'SHARE_ONLY')) {
              fetchComments()
            }
          }
        }
      } catch (error) {
        // Silent fail
      } finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    loadProject()

    return () => {
      isMounted = false
    }
  }, [id, fetchComments])

  const permissions = normalizeRolePermissions(adminUser?.permissions)
  const canManageShareComments = canDoAction(permissions, 'manageSharePageComments')

  const fetchAlbums = useCallback(async (shareSlug: string) => {
    if (!shareSlug) return
    if (project?.enablePhotos === false) {
      setAlbums([])
      return
    }

    setAlbumsLoading(true)
    try {
      const res = await apiFetch(`/api/share/${shareSlug}/albums`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        setAlbums(Array.isArray((data as any)?.albums) ? (data as any).albums : [])
      }
    } catch {
      // ignore
    } finally {
      setAlbumsLoading(false)
    }
  }, [project?.enablePhotos])

  // Fetch albums once the project is loaded (admin sessions can use the share endpoints without a bearer token).
  useEffect(() => {
    if (!project?.slug) return
    void fetchAlbums(String(project.slug))
  }, [fetchAlbums, project?.slug])

  // If photos are disabled, ensure we can't be stuck in an album view.
  useEffect(() => {
    if (project?.enablePhotos === false && activeAlbumId) {
      setActiveAlbumId(null)
    }
  }, [activeAlbumId, project?.enablePhotos])

  // Listen for comment updates (post, delete, etc.)
  useEffect(() => {
    const handleCommentPosted = (e: CustomEvent) => {
      // Use the comments data from the event if available, otherwise refetch
      if (e.detail?.comments) {
        setComments(e.detail.comments)
      } else {
        fetchComments()
      }
    }

    const handleCommentDeleted = () => {
      fetchComments()
    }

    window.addEventListener('commentPosted', handleCommentPosted as EventListener)
    window.addEventListener('commentDeleted', handleCommentDeleted)

    return () => {
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
      window.removeEventListener('commentDeleted', handleCommentDeleted)
    }
  }, [fetchComments])

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    if (activeAlbumId) return
    if (project?.enableVideos === false) return
    if (project?.videosByName) {
      // Sort video names: prioritize the sidebar "For Review" group (no approved versions), then "Approved", then alphabetically.
      // Keep this in sync with the grouping logic in VideoSidebar.
      const names = Object.keys(project.videosByName)
      const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
      const isApprovedGroup = (videoName: string) => (project.videosByName[videoName] || []).some((v: any) => v?.approved === true)

      const forReview = names.filter((n) => !isApprovedGroup(n)).sort(byName)
      const approved = names.filter((n) => isApprovedGroup(n)).sort(byName)
      const videoNames = [...forReview, ...approved]
      if (videoNames.length === 0) return

      if (!activeVideoName) {
        let videoNameToUse: string | null = null

        if (urlVideoName && project.videosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
        } else {
          const savedVideoName = sessionStorage.getItem('approvedVideoName')
          if (savedVideoName) {
            sessionStorage.removeItem('approvedVideoName')
            if (project.videosByName[savedVideoName]) {
              videoNameToUse = savedVideoName
            }
          }
        }

        if (!videoNameToUse) {
          videoNameToUse = videoNames[0]
        }

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        setActiveVideosRaw(videos)

        if (urlVersion !== null && videos) {
          const targetIndex = videos.findIndex((v: any) => v.version === urlVersion)
          if (targetIndex !== -1) {
            setInitialVideoIndex(targetIndex)
          }
        }

        if (urlTimestamp !== null) {
          setInitialSeekTime(urlTimestamp)
        }
      } else {
        const videos = project.videosByName[activeVideoName]
        if (videos) {
          setActiveVideosRaw(videos)
        }
      }
    }
  }, [project?.videosByName, project?.enableVideos, activeVideoName, urlVideoName, urlVersion, urlTimestamp, activeAlbumId])

  // Tokenize active videos lazily
  useEffect(() => {
    let isMounted = true

    async function loadTokens() {
      if (!activeVideosRaw || activeVideosRaw.length === 0) {
        setTokensLoading(false)
        return
      }
      setTokensLoading(true)
      const tokenized = await fetchTokensForVideos(activeVideosRaw)
      if (isMounted) {
        setActiveVideos(tokenized)
      }
      setTokensLoading(false)
    }

    loadTokens()

    return () => {
      isMounted = false
    }
  }, [activeVideosRaw, fetchTokensForVideos])

  // Preload thumbnails for ALL videos on page load (ensures sidebar thumbnails are visible immediately)
  useEffect(() => {
    if (!project?.videosByName) return

    const allVideos = Object.values(project.videosByName)
      .flat()
      .filter((v: any) => !tokenCacheRef.current.has(v.id))

    if (allVideos.length === 0) return

    // Preload in background without blocking UI
    const preloadThumbnails = async () => {
      const tokenized = await fetchTokensForVideos(allVideos)
      
      // Update allVideosByName with tokenized videos
      setAllVideosByName((prev) => {
        const updated = { ...prev }
        tokenized.forEach((video: any) => {
          const videoName = Object.entries(project.videosByName).find(
            ([_, videos]: any) => (videos as any[]).some((v: any) => v.id === video.id)
          )?.[0]
          
          if (videoName) {
            if (!updated[videoName]) {
              updated[videoName] = []
            }
            updated[videoName] = updated[videoName].map((v: any) => 
              v.id === video.id ? video : v
            )
            if (!updated[videoName].some((v: any) => v.id === video.id)) {
              updated[videoName].push(video)
            }
          }
        })
        return updated
      })
    }

    preloadThumbnails().catch(() => {
      // Silently fail - this is just a performance optimization
    })
  }, [project?.videosByName, fetchTokensForVideos])

  // Handle video selection (identical to public share)
  const handleVideoSelect = (videoName: string) => {
    setActiveAlbumId(null)
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
  }

  const handleAlbumSelect = (albumId: string) => {
    setActiveAlbumId(albumId)
  }

  // Photos-only projects: default to first album once albums load.
  useEffect(() => {
    if (!project) return
    if (project.enablePhotos === false) return
    if (project.enableVideos !== false) return
    if (activeAlbumId) return
    if (!Array.isArray(albums) || albums.length === 0) return
    setActiveAlbumId(String(albums[0]?.id))
  }, [activeAlbumId, albums, project])

  // Show loading state while project loads
  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // Show project not found
  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">Project not found</p>
            <Link href="/admin/projects">
              <Button>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Projects
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter to READY videos first (identical to public share)
  let readyVideos = (project?.enableVideos === false)
    ? []
    : activeVideos.filter((v: any) => v.status === 'READY')

  // If any video is approved, show ONLY approved videos (for both admin and client)
  const hasApprovedVideo = readyVideos.some((v: any) => v.approved)
  if (hasApprovedVideo) {
    readyVideos = readyVideos.filter((v: any) => v.approved)
  }

  const hasMultipleVideos = project.videosByName && Object.keys(project.videosByName).length > 1

  // Filter comments to only show comments for active videos (identical to public share)
  const activeVideoIds = new Set(activeVideos.map((v: any) => v.id))
  const filteredComments = comments.filter((comment: any) => {
    // Show general comments (no videoId) or comments for active videos
    return !comment.videoId || activeVideoIds.has(comment.videoId)
  })

  const projectUrl = `/admin/projects/${id}`

  const clientDisplayName = (() => {
    const primaryRecipient = project.recipients?.find((r: any) => r.isPrimary) || project.recipients?.[0]
    return project.companyName || primaryRecipient?.name || primaryRecipient?.email || 'Client'
  })()

  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col overflow-y-auto lg:overflow-hidden">
      {/* Subheader (match Project page back-row styling) */}
      <div className="flex-shrink-0">
        <div className="max-w-screen-2xl mx-auto w-full px-3 sm:px-4 lg:px-6 pt-3 sm:pt-6">
          <div className="mb-3 sm:mb-4">
            <div className="flex items-center gap-2">
              <div className="flex-shrink-0">
                <Link href={projectUrl}>
                  <Button variant="ghost" size="default" className="justify-start px-3">
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    <span className="hidden sm:inline">Back to Project</span>
                    <span className="sm:hidden">Back</span>
                  </Button>
                </Link>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-end lg:justify-center gap-2 sm:gap-3 min-w-0">
                  <span className="text-lg sm:text-xl font-semibold text-foreground truncate">
                    {project.title}
                  </span>
                  <span className="text-sm sm:text-lg font-medium text-muted-foreground flex-shrink-0">
                    Share view
                  </span>
                </div>
              </div>

              {/* Spacer to keep the title truly centered on desktop */}
              <div className="hidden lg:block flex-shrink-0 opacity-0 pointer-events-none" aria-hidden="true">
                <Button variant="ghost" size="default" className="justify-start px-3" tabIndex={-1}>
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">Back to Project</span>
                  <span className="sm:hidden">Back</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        {/* Video Sidebar */}
        <VideoSidebar
          videosByName={Object.keys(allVideosByName).length > 0 ? allVideosByName : (project.videosByName || {})}
          activeVideoName={activeVideoName}
          onVideoSelect={handleVideoSelect}
          albums={albums.map((a: any) => ({
            id: String(a.id),
            name: String(a.name || ''),
            photoCount: Number(a?._count?.photos || 0),
            previewPhotoUrl: (a as any)?.previewPhotoUrl || null,
          }))}
          activeAlbumId={activeAlbumId}
          onAlbumSelect={handleAlbumSelect}
          showVideos={project.enableVideos !== false}
          showAlbums={project.enablePhotos !== false}
          className="flex-shrink-0 h-[calc(100dvh-var(--admin-header-height))]"
        />

        {/* Main Content Area */}
        <div className={cn('flex-1 flex flex-col min-w-0 overflow-x-hidden', activeAlbumId ? 'overflow-hidden' : 'overflow-y-auto')}>
          <div className="w-full px-4 sm:px-6 lg:px-8 py-4 sm:py-8 flex-1 min-h-0 flex flex-col">
            {/* Main Content */}
            {activeAlbumId ? (
              <ShareAlbumViewer shareSlug={String(project.slug)} shareToken={null} albumId={activeAlbumId} />
            ) : project.enableVideos === false ? (
              <Card className="bg-card border-border rounded-lg">
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground">
                    {albumsLoading ? 'Loading albums…' : 'Select an album to view photos.'}
                  </p>
                </CardContent>
              </Card>
            ) : readyVideos.length === 0 ? (
              <Card className="bg-card border-border rounded-lg flex-1 flex">
                <CardContent className="flex-1 flex items-center justify-center text-center px-6 py-12">
                  <p className="text-muted-foreground">
                    {tokensLoading ? 'Loading video...' : 'No content is ready for review yet. Please check back later.'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div
                className={`flex-1 min-h-0 ${(project.hideFeedback || project.status === 'SHARE_ONLY')
                  ? 'flex flex-col w-full'
                  : 'flex flex-col lg:flex-row gap-4 sm:gap-6 lg:-mx-8 lg:-my-8'}`}
              >
                {(project.hideFeedback || project.status === 'SHARE_ONLY') ? (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <VideoPlayer
                      videos={readyVideos}
                      projectId={project.id}
                      projectStatus={project.status}
                      defaultQuality={defaultQuality}
                      projectTitle={project.title}
                      clientName={project.clientName}
                      isPasswordProtected={!!project.sharePassword}
                      watermarkEnabled={project.watermarkEnabled}
                      activeVideoName={activeVideoName}
                      initialSeekTime={initialSeekTime}
                      initialVideoIndex={initialVideoIndex}
                      isAdmin={true}
                      isGuest={false}
                      shareToken={null}
                      onApprove={undefined}
                      hideDownloadButton={true}
                      commentsForTimeline={filteredComments}
                      fillContainer
                    />
                  </div>
                ) : (
                  <AdminShareFeedbackGrid
                    project={project}
                    readyVideos={readyVideos}
                    filteredComments={filteredComments}
                    defaultQuality={defaultQuality}
                    activeVideoName={activeVideoName}
                    initialSeekTime={initialSeekTime}
                    initialVideoIndex={initialVideoIndex}
                    companyName={companyName}
                    adminUser={adminUser}
                    clientDisplayName={clientDisplayName}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AdminShareFeedbackGrid({
  project,
  readyVideos,
  filteredComments,
  defaultQuality,
  activeVideoName,
  initialSeekTime,
  initialVideoIndex,
  companyName,
  adminUser,
  clientDisplayName,
}: {
  project: any
  readyVideos: any[]
  filteredComments: any[]
  defaultQuality: any
  activeVideoName: string
  initialSeekTime: number | null
  initialVideoIndex: number
  companyName: string
  adminUser: any
  clientDisplayName: string
}) {
  const [isDesktop, setIsDesktop] = useState(false)
  const [commentsWidth, setCommentsWidth] = useState(420)
  const [isResizingComments, setIsResizingComments] = useState(false)
  const [commentInputInRightColumn, setCommentInputInRightColumn] = useState(false)
  const [commentInputPlacementManuallySet, setCommentInputPlacementManuallySet] = useState(false)
  const [commentInputMinWidth, setCommentInputMinWidth] = useState<number | null>(null)

  const feedbackContainerRef = useRef<HTMLDivElement>(null)
  const leftPaneRef = useRef<HTMLDivElement>(null)
  const commentInputMeasureRef = useRef<HTMLDivElement>(null)

  const [serverComments, setServerComments] = useState<any[]>(filteredComments)

  const projectId = String(project?.id || '')

  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(media.matches)
    update()

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update)
      return () => media.removeEventListener('change', update)
    }

    media.addListener(update)
    return () => media.removeListener(update)
  }, [])

  // Desktop-only: if we leave desktop, always return input to the left.
  useEffect(() => {
    if (isDesktop) return
    setCommentInputInRightColumn(false)
    setCommentInputPlacementManuallySet(false)
  }, [isDesktop])

  useEffect(() => {
    if (!isDesktop) return
    // Re-measure when the input moves between columns.
    setCommentInputMinWidth(null)
  }, [isDesktop, commentInputInRightColumn])

  // Desktop/right-column only: if the comment input overflows horizontally, lock the panel's minimum width
  // to whatever is required to avoid clipping.
  useEffect(() => {
    if (!isDesktop || !commentInputInRightColumn) return

    const raf = window.requestAnimationFrame(() => {
      const el = commentInputMeasureRef.current
      if (!el) return

      const available = Math.round(el.clientWidth)
      const needed = Math.round(el.scrollWidth)

      if (Number.isFinite(available) && Number.isFinite(needed) && needed > available + 1) {
        setCommentInputMinWidth((prev) => Math.max(prev ?? 352, needed))
      }
    })

    return () => window.cancelAnimationFrame(raf)
  }, [isDesktop, commentInputInRightColumn, commentsWidth])

  useEffect(() => {
    if (!isDesktop) return
    const onResize = () => {
      setCommentInputMinWidth(null)
      // Clamp comments width so it never exceeds 60% of the viewport on resize.
      setCommentsWidth((prev) => {
        const max = Math.floor(window.innerWidth * 0.6)
        return prev > max ? max : prev
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isDesktop])

  // If the input is in the right column, ensure the column width is at least the measured minimum.
  useEffect(() => {
    if (!isDesktop) return
    if (!commentInputInRightColumn) return
    if (commentInputMinWidth === null) return
    if (commentsWidth >= commentInputMinWidth) return
    setCommentsWidth(commentInputMinWidth)
  }, [isDesktop, commentInputInRightColumn, commentInputMinWidth, commentsWidth])

  // Load saved sizes (desktop only)
  useEffect(() => {
    if (!isDesktop) return
    const savedWidth = localStorage.getItem('share_comments_width')
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (Number.isFinite(width) && width >= 352 && width <= window.innerWidth * 0.6) {
        setCommentsWidth(width)
      }
    }
  }, [isDesktop])

  // Handle mouse move for horizontal resizing (comments panel)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingComments) return
      if (!feedbackContainerRef.current) return

      const rect = feedbackContainerRef.current.getBoundingClientRect()
      const nextWidth = rect.right - e.clientX
      const minWidth = commentInputInRightColumn && commentInputMinWidth ? commentInputMinWidth : 352
      const maxWidth = Math.min(rect.width * 0.6, window.innerWidth * 0.6)

      const clamped = Math.max(minWidth, Math.min(maxWidth, nextWidth))
      setCommentsWidth(clamped)
    }

    const handleMouseUp = () => {
      if (isResizingComments) {
        setIsResizingComments(false)
        localStorage.setItem('share_comments_width', Math.round(commentsWidth).toString())
      }
    }

    if (isResizingComments) {
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
  }, [isResizingComments, commentsWidth, commentInputInRightColumn, commentInputMinWidth])

  const startResizeComments = (e: React.MouseEvent) => {
    if (!isDesktop) return
    e.preventDefault()
    setIsResizingComments(true)
  }

  useEffect(() => {
    setServerComments(filteredComments)
  }, [filteredComments])

  const fetchComments = useCallback(async () => {
    try {
      if (!projectId) return
      const response = await apiFetch(`/api/comments?projectId=${projectId}`)
      if (!response.ok) return
      const fresh = await response.json()
      setServerComments(fresh)
    } catch {
      // ignore
    }
  }, [projectId])

  useEffect(() => {
    const handleCommentPosted = (e: any) => {
      if (e?.detail?.comments) {
        setServerComments(e.detail.comments)
      } else {
        fetchComments()
      }
    }

    const handleCommentDeleted = () => {
      fetchComments()
    }

    window.addEventListener('commentPosted', handleCommentPosted as EventListener)
    window.addEventListener('commentDeleted', handleCommentDeleted as EventListener)

    return () => {
      window.removeEventListener('commentPosted', handleCommentPosted as EventListener)
      window.removeEventListener('commentDeleted', handleCommentDeleted as EventListener)
    }
  }, [fetchComments])

  const permissions = normalizeRolePermissions(adminUser?.permissions)
  const canManageShareComments = canDoAction(permissions, 'manageSharePageComments')

  const management = useCommentManagement({
    projectId: String(project.id),
    initialComments: serverComments as any,
    videos: readyVideos as any,
    clientEmail: project.recipients?.[0]?.email,
    isPasswordProtected: Boolean(project.sharePassword),
    adminUser,
    recipients: (project.recipients || []) as any,
    clientName: clientDisplayName,
    restrictToLatestVersion: Boolean(project.restrictCommentsToLatestVersion),
    shareToken: null,
    useAdminAuth: true,
    isInternalOverride: false,
    canAdminManageComments: canManageShareComments,
    companyName,
    allowClientDeleteComments: Boolean(project.allowClientDeleteComments),
    allowClientUploadFiles: false,
  })

  const isApproved = project.status === 'APPROVED' || project.status === 'SHARE_ONLY'

  const latestVideoVersion = readyVideos.length > 0
    ? Math.max(...readyVideos.map((v: any) => v.version))
    : null

  const selectedVideo = readyVideos.find((v: any) => v.id === management.selectedVideoId)
  const selectedVideoApproved = selectedVideo ? Boolean(selectedVideo.approved) : false
  const anyApproved = readyVideos.some((v: any) => Boolean(v.approved))
  const commentsDisabled = Boolean(isApproved || selectedVideoApproved || anyApproved || !canManageShareComments)

  // Desktop-only: default placement based on selected video aspect ratio.
  // - Between 16:9 and 1:1 (inclusive of 1:1): keep under video player (left column)
  // - Taller than 1:1 (e.g., 4:5, 9:16): place under comments (right column)
  // Manual moves override this for the rest of the session.
  useEffect(() => {
    if (!isDesktop) return
    if (commentInputPlacementManuallySet) return
    if (!selectedVideo) return

    const width = Number(
      (selectedVideo as any).width ??
        (selectedVideo as any).videoWidth ??
        (selectedVideo as any).metadata?.width
    )
    const height = Number(
      (selectedVideo as any).height ??
        (selectedVideo as any).videoHeight ??
        (selectedVideo as any).metadata?.height
    )

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return

    const aspect = width / height
    setCommentInputInRightColumn(aspect < 1)
  }, [isDesktop, commentInputPlacementManuallySet, selectedVideo])

  const currentVideoRestricted = Boolean(
    project.restrictCommentsToLatestVersion &&
      management.selectedVideoId &&
      selectedVideo &&
      latestVideoVersion !== null &&
      selectedVideo.version !== latestVideoVersion
  )

  const restrictionMessage = currentVideoRestricted
    ? `You can only leave feedback on the latest version. Please switch to version ${latestVideoVersion} to comment.`
    : undefined

  return (
    <>
      <div ref={feedbackContainerRef} className="flex flex-col lg:flex-row flex-1 lg:min-h-0 gap-4 sm:gap-6 lg:gap-0 lg:overflow-hidden">
        <div
          ref={leftPaneRef}
          className="lg:flex-1 lg:min-h-0 min-w-0 flex flex-col lg:pl-8 lg:pr-8 lg:py-8 lg:overflow-hidden lg:h-[calc(100dvh-var(--admin-header-height,0px))]"
        >
          <div
            className="flex-1 lg:min-h-0 lg:overflow-hidden"
          >
            <VideoPlayer
              videos={readyVideos}
              projectId={project.id}
              projectStatus={project.status}
              defaultQuality={defaultQuality}
              projectTitle={project.title}
              clientName={project.clientName}
              isPasswordProtected={!!project.sharePassword}
              watermarkEnabled={project.watermarkEnabled}
              activeVideoName={activeVideoName}
              initialSeekTime={initialSeekTime}
              initialVideoIndex={initialVideoIndex}
              isAdmin={true}
              isGuest={false}
              shareToken={null}
              onApprove={undefined}
              hideDownloadButton={true}
              commentsForTimeline={management.comments as any}
              fillContainer
              pinControlsToBottom={!commentInputInRightColumn && !commentsDisabled}
            />
          </div>

          {!commentInputInRightColumn && (
            <div ref={commentInputMeasureRef} className="mt-4 flex-shrink-0">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                selectedTimestamp={management.selectedTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={Boolean(project?.useFullTimecode)}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={false}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipients={project.recipients || []}
                currentVideoRestricted={currentVideoRestricted}
                restrictionMessage={restrictionMessage}
                commentsDisabled={commentsDisabled}
                showShortcutsButton={true}
                onShowShortcuts={() => window.dispatchEvent(new CustomEvent('openShortcutsDialog'))}
                containerClassName="border border-border rounded-lg"
                showTopBorder={false}
                onMoveColumn={() => {
                  setCommentInputPlacementManuallySet(true)
                  setCommentInputInRightColumn(true)
                }}
                moveColumnDirection="right"
              />
            </div>
          )}
        </div>

        <div
          className={cn(
            'relative lg:sticky lg:top-0 lg:self-stretch lg:h-[calc(100dvh-var(--admin-header-height,0px))] lg:min-h-0 lg:overflow-hidden lg:flex-shrink-0',
            'lg:flex lg:flex-col'
          )}
          style={
            isDesktop
              ? {
                  width: `${Math.round(commentsWidth)}px`,
                  maxWidth: '60%',
                  minWidth:
                    commentInputInRightColumn && commentInputMinWidth
                      ? `${Math.round(commentInputMinWidth)}px`
                      : undefined,
                }
              : undefined
          }
        >
          {/* Horizontal resize handle (desktop only) */}
          <div
            onMouseDown={startResizeComments}
            className={cn(
              'hidden lg:block',
              'absolute left-0 top-0 bottom-0 w-1 cursor-col-resize select-none z-10',
              'hover:bg-primary transition-colors',
              'group'
            )}
          >
            <div className="absolute left-0 top-1/2 -translate-y-1/2 translate-x-1/2">
              <GripVertical className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
          </div>

          <div className="lg:flex-1 lg:min-h-0 overflow-hidden flex flex-col">
            <CommentSectionView
              projectId={project.id}
              projectSlug={project.slug}
              guestModeEnabled={Boolean(project.guestMode)}
              comments={serverComments as any}
              clientName={clientDisplayName}
              clientEmail={project.recipients?.[0]?.email}
              isApproved={isApproved}
              restrictToLatestVersion={Boolean(project.restrictCommentsToLatestVersion)}
              useFullTimecode={Boolean(project?.useFullTimecode)}
              videos={readyVideos as any}
              isAdminView={true}
              canAdminDeleteComments={canManageShareComments}
              companyName={companyName}
              clientCompanyName={project.companyName}
              smtpConfigured={project.smtpConfigured}
              isPasswordProtected={!!project.sharePassword}
              adminUser={adminUser}
              recipients={project.recipients || []}
              shareToken={null}
              showShortcutsButton={true}
              allowClientDeleteComments={project.allowClientDeleteComments}
              hideInput={true}
              showApproveButton={false}
              management={management as any}
            />
          </div>

          {commentInputInRightColumn && !commentsDisabled ? (
            <div ref={commentInputMeasureRef} className="mt-4 flex-shrink-0">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                selectedTimestamp={management.selectedTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={Boolean(project?.useFullTimecode)}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={false}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipients={project.recipients || []}
                currentVideoRestricted={currentVideoRestricted}
                restrictionMessage={restrictionMessage}
                commentsDisabled={commentsDisabled}
                showShortcutsButton={true}
                onShowShortcuts={() => window.dispatchEvent(new CustomEvent('openShortcutsDialog'))}
                containerClassName="border border-border rounded-lg"
                showTopBorder={false}
                onMoveColumn={() => {
                  setCommentInputPlacementManuallySet(true)
                  setCommentInputInRightColumn(false)
                }}
                moveColumnDirection="left"
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
