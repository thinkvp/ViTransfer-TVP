'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import VideoPlayer from '@/components/VideoPlayer'
import CommentInput from '@/components/CommentInput'
import { CommentSectionView } from '@/components/CommentSection'
import VideoSidebar from '@/components/VideoSidebar'
import { ShareFilesBrowser } from '@/components/ShareFilesBrowser'
import { ShareProjectSwitcher, type ShareProjectOption } from '@/components/ShareProjectSwitcher'
import { ShareAlbumViewer } from '@/components/ShareAlbumViewer'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ArrowLeft, Info, Share2 } from 'lucide-react'
import { apiFetch } from '@/lib/api-client'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { cn } from '@/lib/utils'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, isImageFileName } from '@/lib/downloadable-file-utils'
import type { DownloadQueueItem } from '@/lib/download-queue'
import { useDownloadTransfers } from '@/hooks/useDownloadTransfers'

type DraftNavigationGuard = {
  confirmDiscardDraft: () => boolean
}

type AdminSwitchableProject = {
  id: string
  slug: string
  title: string
  status: string
  updatedAt: string
  clientName?: string | null
}

const UNSENT_COMMENT_MESSAGE = 'You have an unsent comment. Are you sure you want to leave?'

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
  const [downloadableFiles, setDownloadableFiles] = useState<DownloadableGroup[] | null>(null)
  const [hasApprovableVideos, setHasApprovableVideos] = useState(false)
  const [desktopContentTab, setDesktopContentTab] = useState<'view' | 'files'>('view')
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [switchableProjects, setSwitchableProjects] = useState<AdminSwitchableProject[]>([])
  const [switchProjectsLoading, setSwitchProjectsLoading] = useState(false)
  const [switchProjectsError, setSwitchProjectsError] = useState<string | null>(null)
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null)
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null)
  const [headerVersionId, setHeaderVersionId] = useState<string | null>(null)
  const [requestedFilesFolderName, setRequestedFilesFolderName] = useState<string | null>(null)
  const draftGuardRef = useRef<DraftNavigationGuard | null>(null)
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const tokenRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const sidebarVideoCacheRef = useRef<Map<string, any>>(new Map())
  const sidebarThumbnailRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const sessionIdRef = useRef<string>(`admin:${Date.now()}`)

  const availableFileCount = useMemo(() => {
    return (downloadableFiles || []).reduce((total, group) => {
      return total + (group.mainFile ? 1 : 0) + group.subFiles.length
    }, 0)
  }, [downloadableFiles])

  const confirmShareDraftNavigation = useCallback(() => {
    const guard = draftGuardRef.current
    return guard ? guard.confirmDiscardDraft() : true
  }, [])

  const markVideoApproved = useCallback((videoId: string) => {
    if (!videoId) return

    const markApproved = (video: any) =>
      video && video.id === videoId ? { ...video, approved: true } : video

    setHeaderVersionId(videoId)
    tokenCacheRef.current.delete(videoId)
    sidebarVideoCacheRef.current.delete(videoId)

    setActiveVideos((prev) => prev.map(markApproved))
    setActiveVideosRaw((prev) => prev.map(markApproved))
    setAllVideosByName((prev) => {
      const entries = Object.entries(prev)
      if (entries.length === 0) return prev

      let changed = false
      const next = Object.fromEntries(
        entries.map(([name, videos]) => {
          const updatedVideos = videos.map((video: any) => {
            const updated = markApproved(video)
            if (updated !== video) changed = true
            return updated
          })
          return [name, updatedVideos]
        })
      )

      return changed ? next : prev
    })
    setProject((prev: any) => {
      if (!prev) return prev

      let changed = false
      const nextVideos = Array.isArray(prev.videos)
        ? prev.videos.map((video: any) => {
            const updated = markApproved(video)
            if (updated !== video) changed = true
            return updated
          })
        : prev.videos

      const nextVideosByName = prev.videosByName && typeof prev.videosByName === 'object'
        ? Object.fromEntries(
            Object.entries(prev.videosByName).map(([name, videos]: [string, any]) => {
              const updatedVideos = (Array.isArray(videos) ? videos : []).map((video: any) => {
                const updated = markApproved(video)
                if (updated !== video) changed = true
                return updated
              })
              return [name, updatedVideos]
            })
          )
        : prev.videosByName

      if (!changed) return prev
      return {
        ...prev,
        videos: nextVideos,
        videosByName: nextVideosByName,
      }
    })
  }, [])

  // Reset header version when active video changes
  useEffect(() => {
    setHeaderVersionId(null)
  }, [activeVideoName])

  // Sync header version from VideoPlayer / CommentSection events
  useEffect(() => {
    const handleVideoChanged = (e: Event) => {
      const videoId = (e as CustomEvent).detail?.videoId
      if (videoId) setHeaderVersionId(videoId)
    }
    const handleSelectVideo = (e: Event) => {
      const videoId = (e as CustomEvent).detail?.videoId
      if (videoId) setHeaderVersionId(videoId)
    }
    window.addEventListener('videoChanged', handleVideoChanged)
    window.addEventListener('selectVideoForComments', handleSelectVideo)
    return () => {
      window.removeEventListener('videoChanged', handleVideoChanged)
      window.removeEventListener('selectVideoForComments', handleSelectVideo)
    }
  }, [])

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

    return Promise.all(
      videos.map(async (video: any) => {
        const cached = tokenCacheRef.current.get(video.id)
        if (cached) {
          return cached
        }

        const inFlight = tokenRequestCacheRef.current.get(video.id)
        if (inFlight) {
          return inFlight
        }

        const request = (async () => {
          try {
            const [response480p, response720p, response1080p, responseOriginal] = await Promise.all([
              // Only request a preview token for a resolution that actually has a preview file.
              // The content route does its own fallback when serving, but the player uses the
              // presence of streamUrl480p/720p/1080p to decide which quality options to offer;
              // we must not populate them with the original-video token when no preview exists.
              video.preview480Path
                ? apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=480p&sessionId=${sessionId}`)
                : Promise.resolve(null),
              video.preview720Path
                ? apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=720p&sessionId=${sessionId}`)
                : Promise.resolve(null),
              video.preview1080Path
                ? apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=1080p&sessionId=${sessionId}`)
                : Promise.resolve(null),
              video.originalStoragePath
                ? apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=original&sessionId=${sessionId}`)
                : Promise.resolve(null),
            ])

            let streamToken480p = ''
            let streamToken720p = ''
            let streamToken1080p = ''
            let downloadToken = null
            let originalStreamToken = ''

            if (response480p?.ok) {
              const data480p = await response480p.json()
              streamToken480p = data480p.token
            }

            if (response720p?.ok) {
              const data720p = await response720p.json()
              streamToken720p = data720p.token
            }

            if (response1080p?.ok) {
              const data1080p = await response1080p.json()
              streamToken1080p = data1080p.token
            }

            if (responseOriginal?.ok) {
              const dataOriginal = await responseOriginal.json()
              downloadToken = dataOriginal.token
              originalStreamToken = dataOriginal.token || ''
              // Do NOT fall back preview stream tokens to the original here.
              // streamUrlOriginal in the tokenized object handles the "no previews" case.
            }

            let thumbnailUrl = sidebarVideoCacheRef.current.get(video.id)?.thumbnailUrl ?? null
            if (!thumbnailUrl && video.thumbnailPath) {
              const responseThumbnail = await apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=thumbnail&sessionId=${sessionId}`)
              if (responseThumbnail.ok) {
                const dataThumbnail = await responseThumbnail.json()
                thumbnailUrl = dataThumbnail.token ? `/api/content/${dataThumbnail.token}` : null
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
              streamUrl480p: streamToken480p ? `/api/content/${streamToken480p}` : '',
              streamUrl720p: streamToken720p ? `/api/content/${streamToken720p}` : '',
              streamUrl1080p: streamToken1080p ? `/api/content/${streamToken1080p}` : '',
              streamUrlOriginal: originalStreamToken ? `/api/content/${originalStreamToken}` : '',
              downloadUrl: downloadToken ? `/api/content/${downloadToken}?download=true` : null,
              thumbnailUrl,
              timelineVttUrl,
              timelineSpriteUrl,
            }

            tokenCacheRef.current.set(video.id, tokenized)
            sidebarVideoCacheRef.current.set(video.id, tokenized)
            return tokenized
          } catch (error) {
            return video
          } finally {
            tokenRequestCacheRef.current.delete(video.id)
          }
        })()

        tokenRequestCacheRef.current.set(video.id, request)
        return request
      })
    )
  }, [id, project])

  const fetchSidebarVideos = useCallback(async (videos: any[]) => {
    const sessionId = sessionIdRef.current
    const shouldFetchTimelinePreviews = !!project?.timelinePreviewsEnabled

    return Promise.all(
      videos.map(async (video: any) => {
        const fullCached = tokenCacheRef.current.get(video.id)
        if (fullCached) {
          return fullCached
        }

        const sidebarCached = sidebarVideoCacheRef.current.get(video.id)
        if (sidebarCached) {
          return sidebarCached
        }

        const inFlight = sidebarThumbnailRequestCacheRef.current.get(video.id)
        if (inFlight) {
          return inFlight
        }

        const request = (async () => {
          try {
            let thumbnailUrl = null
            if (video.thumbnailPath) {
              const responseThumbnail = await apiFetch(`/api/admin/video-token?videoId=${video.id}&projectId=${id}&quality=thumbnail&sessionId=${sessionId}`)
              if (responseThumbnail.ok) {
                const dataThumbnail = await responseThumbnail.json()
                thumbnailUrl = dataThumbnail.token ? `/api/content/${dataThumbnail.token}` : null
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

            const sidebarVideo = {
              ...video,
              thumbnailUrl,
              timelineVttUrl,
              timelineSpriteUrl,
            }

            sidebarVideoCacheRef.current.set(video.id, sidebarVideo)
            return sidebarVideo
          } catch {
            return video
          } finally {
            sidebarThumbnailRequestCacheRef.current.delete(video.id)
          }
        })()

        sidebarThumbnailRequestCacheRef.current.set(video.id, request)
        return request
      })
    )
  }, [id, project?.timelinePreviewsEnabled])

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

  const fetchDownloadableFiles = useCallback(async () => {
    if (!project?.slug) return
    try {
      const res = await apiFetch(`/api/share/${project.slug}/downloadable-files`)
      if (res.ok) {
        const data = await res.json()
        setDownloadableFiles(Array.isArray(data.groups) ? data.groups : [])
        setHasApprovableVideos(!!data.hasApprovableVideos)
      }
    } catch {
      // ignore
    }
  }, [project?.slug])

  const fetchSwitchableProjects = useCallback(async () => {
    if (!project?.id) return

    setSwitchProjectsLoading(true)
    setSwitchProjectsError(null)
    try {
      const response = await apiFetch('/api/admin/share-projects', { cache: 'no-store' })
      if (!response.ok) {
        setSwitchProjectsError('Unable to load projects right now.')
        setSwitchableProjects([])
        return
      }

      const data = await response.json().catch(() => ({}))
      const allProjects = Array.isArray((data as any)?.projects) ? (data as any).projects : []
      setSwitchableProjects(allProjects.filter((entry: any) => String(entry?.id || '') !== String(project.id)))
    } catch {
      setSwitchProjectsError('Unable to load projects right now.')
      setSwitchableProjects([])
    } finally {
      setSwitchProjectsLoading(false)
    }
  }, [project?.id])

  const handleProjectSwitch = useCallback(async (targetProject: AdminSwitchableProject) => {
    if (!targetProject?.id) return
    if (targetProject.id === String(project?.id || '')) return
    if (!confirmShareDraftNavigation()) return

    setSwitchingProjectId(targetProject.id)
    try {
      router.push(`/admin/projects/${targetProject.id}/share`)
    } finally {
      setSwitchingProjectId(null)
    }
  }, [confirmShareDraftNavigation, project?.id, router])

  useEffect(() => {
    const allKeys = new Set(
      (downloadableFiles || [])
        .flatMap((group) => [
          ...(group.mainFile ? [group.mainFile] : []),
          ...group.subFiles,
        ])
        .map((file) => getDownloadableFileKey(file))
    )

    setSelectedFileIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set(Array.from(prev).filter((key) => allKeys.has(key)))
      return next.size === prev.size ? prev : next
    })

    if (downloadableFiles === null) {
      setDesktopContentTab('view')
    }
  }, [downloadableFiles])

  // Fetch albums once the project is loaded (admin sessions can use the share endpoints without a bearer token).
  useEffect(() => {
    if (!project?.slug) return
    void fetchAlbums(String(project.slug))
  }, [fetchAlbums, project?.slug])

  // Fetch downloadable files once the project is loaded.
  useEffect(() => {
    if (!project?.slug) return
    void fetchDownloadableFiles()
  }, [project?.slug, fetchDownloadableFiles])

  useEffect(() => {
    if (!project?.id) {
      setSwitchableProjects([])
      setSwitchProjectsError(null)
      return
    }
    void fetchSwitchableProjects()
  }, [project?.id, fetchSwitchableProjects])

  useEffect(() => {
    const handleOpenFilesForVideo = (event: Event) => {
      const detail = (event as CustomEvent<{ folderName?: string }>).detail
      const folderName = String(detail?.folderName || '').trim()
      setDesktopContentTab('files')
      if (folderName) {
        setRequestedFilesFolderName(folderName)
      }
    }

    window.addEventListener('shareOpenFilesForVideo', handleOpenFilesForVideo as EventListener)
    return () => {
      window.removeEventListener('shareOpenFilesForVideo', handleOpenFilesForVideo as EventListener)
    }
  }, [])

  // Refresh downloadable files when a video is approved.
  useEffect(() => {
    const handleApprovalChanged = (e: Event) => {
      const videoId = (e as CustomEvent).detail?.videoId
      if (videoId) {
        markVideoApproved(videoId)
      }
      void fetchDownloadableFiles()
    }
    window.addEventListener('videoApprovalChanged', handleApprovalChanged)
    return () => window.removeEventListener('videoApprovalChanged', handleApprovalChanged)
  }, [fetchDownloadableFiles, markVideoApproved])

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
      const tokenized = await fetchSidebarVideos(allVideos)
      
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
  }, [project?.videosByName, fetchSidebarVideos])

  // Handle video selection (identical to public share)
  const handleVideoSelect = (videoName: string) => {
    if (!activeAlbumId && activeVideoName === videoName) return
    if (!confirmShareDraftNavigation()) return
    setActiveAlbumId(null)
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
    if (desktopContentTab === 'files') {
      setRequestedFilesFolderName(videoName)
    }
  }

  const handleAlbumSelect = (albumId: string) => {
    if (activeAlbumId === albumId) return
    if (!confirmShareDraftNavigation()) return
    const album = albums.find((a: any) => String(a.id) === String(albumId))
    setActiveAlbumId(albumId)
    if (desktopContentTab === 'files') {
      setRequestedFilesFolderName(String(album?.name || ''))
    }
  }

  const resolveDownloadTarget = useCallback(async (file: DownloadableFile, signal?: AbortSignal): Promise<DownloadQueueItem | null> => {
    const sessionId = sessionIdRef.current
    try {
      let url: string
      if (file.type === 'video') {
        const r = await apiFetch(`/api/admin/video-token?videoId=${file.videoId}&projectId=${id}&quality=original&sessionId=${sessionId}`, { signal })
        const data = await r.json()
        url = `/api/content/${data.token}?download=true`
      } else if (file.type === 'asset') {
        const r = await apiFetch(`/api/videos/${file.videoId}/assets/${file.assetId}/download-token`, { method: 'POST', signal })
        const data = await r.json()
        url = data.url
      } else if (file.type === 'album-zip') {
        const r = await apiFetch(`/api/share/${project?.slug}/albums/${file.albumId}/download-zip-token`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: file.variant }),
        })
        const data = await r.json()
        url = data.url
      } else {
        if (!file.downloadUrl) return null
        url = file.downloadUrl
      }
      return { url, fileName: file.fileName }
    } catch {
      return null
    }
  }, [id, project?.slug])

  const {
    transferItems,
    transferSummary,
    hasActiveTransfers,
    transferPanelVersion,
    downloadFile: handleDownloadFile,
    downloadFiles: handleDownloadFiles,
    cancelActiveTransfers,
    clearCompletedTransfers,
  } = useDownloadTransfers({
    projectTitle: project?.title,
    resolveDownloadTarget,
  })

  const sidebarVideosByName = useMemo(() => {
    return Object.keys(allVideosByName).length > 0 ? allVideosByName : (project?.videosByName || {})
  }, [allVideosByName, project?.videosByName])

  const filePreviewByVideoId = useMemo(() => {
    const map = new Map<string, string>()
    Object.values(sidebarVideosByName).forEach((versions: any) => {
      for (const version of versions as any[]) {
        if (version?.id && typeof version.thumbnailUrl === 'string' && version.thumbnailUrl) {
          map.set(String(version.id), version.thumbnailUrl)
        }
      }
    })
    return map
  }, [sidebarVideosByName])

  const folderPreviewByName = useMemo(() => {
    const map: Record<string, string | null> = {}

    Object.entries(sidebarVideosByName).forEach(([name, versions]: any) => {
      const approved = (versions as any[]).find((v: any) => v?.approved === true)
      const displayVideo = approved || (versions as any[])[0]
      map[name] = displayVideo?.thumbnailUrl || null
    })

    albums.forEach((album: any) => {
      const name = String(album?.name || '')
      if (!name || map[name]) return
      map[name] = (album as any)?.thumbnailPhotoUrl || null
    })

    return map
  }, [albums, sidebarVideosByName])

  const resolveDownloadablePreviewUrl = useCallback(async (file: DownloadableFile): Promise<string | null> => {
    if (file.type === 'album-photo') {
      return file.thumbnailUrl || file.previewUrl || file.downloadUrl || null
    }

    if (file.type === 'video' && file.videoId) {
      return filePreviewByVideoId.get(file.videoId) || null
    }

    if (file.type !== 'asset' || !file.videoId || !file.assetId) return null
    if (!isImageFileName(file.fileName)) return null

    try {
      const response = await apiFetch(`/api/videos/${file.videoId}/assets/${file.assetId}/download-token`, {
        method: 'POST',
      })
      if (!response.ok) return null
      const data = await response.json().catch(() => ({}))
      return typeof (data as any)?.url === 'string' ? String((data as any).url) : null
    } catch {
      return null
    }
  }, [filePreviewByVideoId])

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

  // Header breadcrumb computed values
  const activeAlbum = albums.find((a: any) => String(a.id) === activeAlbumId) || null
  const headerVersion = readyVideos.find((v: any) => v.id === headerVersionId) || readyVideos[0] || null
  const isOlderVersionSelected = readyVideos.length > 1 && headerVersionId !== null && headerVersionId !== readyVideos[0]?.id
  const canSwitchProjects = switchableProjects.length > 0
  const adminSwitcherProjects: ShareProjectOption[] = switchableProjects.map((projectItem) => ({
    id: String(projectItem.id),
    title: String(projectItem.title || ''),
    status: String(projectItem.status || ''),
    clientName: projectItem.clientName || null,
  }))
  const videoNames = project.videosByName ? (() => {
    const names = Object.keys(project.videosByName)
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
    const isApprovedGroup = (n: string) => (project.videosByName[n] || []).some((v: any) => v?.approved === true)
    const forReview = names.filter((n) => !isApprovedGroup(n)).sort(byName)
    const approved = names.filter((n) => isApprovedGroup(n)).sort(byName)
    return [...forReview, ...approved]
  })() : []
  const mediaOptions = [
    ...videoNames.map((name) => ({ value: `video:${name}`, label: name })),
    ...albums.map((a: any) => ({ value: `album:${String(a.id)}`, label: String(a.name || '') })),
  ]
  const selectedMediaValue = activeAlbumId ? `album:${activeAlbumId}` : `video:${activeVideoName}`

  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col overflow-y-auto lg:overflow-hidden">
      {/* Compact breadcrumb header */}
      <div className="flex-shrink-0 h-12 my-[2px] border border-border bg-card rounded-lg flex items-center pl-4 pr-0 gap-1.5 text-sm overflow-x-auto z-40">

        {/* Back to Project */}
        <Link href={projectUrl} className="flex-shrink-0">
          <Button variant="ghost" size="sm" className="h-7 px-2 gap-1">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Back</span>
          </Button>
        </Link>
        <span className="text-muted-foreground flex-shrink-0">/</span>

        {/* Project selector */}
        {canSwitchProjects ? (
          <ShareProjectSwitcher
            currentProjectId={String(project.id)}
            currentProjectTitle={String(project.title || '')}
            currentProjectStatus={String(project.status || '')}
            currentProjectClientName={String(project.client?.name || '')}
            projects={adminSwitcherProjects}
            loading={switchProjectsLoading || Boolean(switchingProjectId)}
            error={switchProjectsError}
            includeClientName={true}
            searchPlaceholder="Search projects or clients..."
            triggerClassName="lg:max-w-[720px]"
            onSelectProject={(target) => {
              const projectToOpen = switchableProjects.find((item) => item.id === target.id)
              if (projectToOpen) {
                void handleProjectSwitch(projectToOpen)
              }
            }}
          />
        ) : (
          <span className="text-foreground font-medium whitespace-nowrap flex-shrink-0 max-w-[25%] truncate" title={project.title}>{project.title}</span>
        )}

        {/* Video / Album section */}
        {(activeVideoName || activeAlbumId) && !(desktopContentTab === 'files' && !requestedFilesFolderName) && (
          <>
            <span className="text-muted-foreground flex-shrink-0">/</span>
            {mediaOptions.length > 1 ? (
              <Select
                value={selectedMediaValue}
                onValueChange={(value) => {
                  if (value.startsWith('video:')) {
                    handleVideoSelect(value.slice(6))
                    return
                  }
                  if (value.startsWith('album:')) {
                    handleAlbumSelect(value.slice(6))
                  }
                }}
              >
                <SelectTrigger className="h-7 text-sm w-auto flex-shrink-0 gap-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mediaOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : !activeAlbumId ? (
              <span className="text-foreground whitespace-nowrap flex-shrink-0 max-w-[30%] truncate" title={activeVideoName}>{activeVideoName}</span>
            ) : (
              <span className="text-foreground whitespace-nowrap flex-shrink-0 max-w-[30%] truncate" title={activeAlbum?.name}>{activeAlbum?.name}</span>
            )}
          </>
        )}

        {/* Version section — hidden in files mode */}
        {!activeAlbumId && readyVideos.length > 0 && desktopContentTab !== 'files' && (
          <>
            <span className="text-muted-foreground flex-shrink-0">/</span>
            {readyVideos.length > 1 ? (
              <Select
                value={headerVersionId || readyVideos[0].id}
                onValueChange={(videoId) => {
                  setHeaderVersionId(videoId)
                  window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId } }))
                  window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId } }))
                  window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId, videoVersion: null } }))
                }}
              >
                <SelectTrigger className="h-7 text-sm w-auto flex-shrink-0 gap-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {readyVideos.map((v: any) => (
                    <SelectItem key={v.id} value={v.id}>{v.versionLabel}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-foreground whitespace-nowrap flex-shrink-0">{headerVersion?.versionLabel || '\u2014'}</span>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7 flex-shrink-0 ml-2"
              onClick={() => {
                if (desktopContentTab !== 'view') {
                  setDesktopContentTab('view')
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('openVideoInfoDialog'))
                  }, 0)
                  return
                }
                window.dispatchEvent(new CustomEvent('openVideoInfoDialog'))
              }}
              title="Video Information"
              aria-label="Video Information"
            >
              <Info className="w-3.5 h-3.5" />
            </Button>
            {project.guestMode && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 sm:hidden"
                  onClick={() => {
                    if (desktopContentTab !== 'view') {
                      setDesktopContentTab('view')
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('openGuestLinkDialog'))
                      }, 0)
                      return
                    }
                    window.dispatchEvent(new CustomEvent('openGuestLinkDialog'))
                  }}
                  title="Share"
                  aria-label="Share"
                >
                  <Share2 className="w-3.5 h-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 flex-shrink-0 hidden sm:inline-flex"
                  onClick={() => {
                    if (desktopContentTab !== 'view') {
                      setDesktopContentTab('view')
                      setTimeout(() => {
                        window.dispatchEvent(new CustomEvent('openGuestLinkDialog'))
                      }, 0)
                      return
                    }
                    window.dispatchEvent(new CustomEvent('openGuestLinkDialog'))
                  }}
                  title="Share"
                  aria-label="Share"
                >
                  <Share2 className="w-3.5 h-3.5 mr-1.5" />
                  Share
                </Button>
              </>
            )}
            {isOlderVersionSelected && (
              <span className="text-amber-600 dark:text-amber-400 text-xs whitespace-nowrap flex-shrink-0">(Newer version available)</span>
            )}
          </>
        )}

        {downloadableFiles !== null && (
          <div className="ml-auto hidden lg:flex items-stretch self-stretch gap-0 flex-shrink-0">
            <span className="text-muted-foreground whitespace-nowrap hidden lg:inline flex-shrink-0 self-center px-2">Mode:</span>
            <Button
              type="button"
              variant={desktopContentTab === 'view' ? 'default' : 'outline'}
              size="default"
              className="h-full rounded-none border-y-0 border-l border-r-0 px-4"
              onClick={() => setDesktopContentTab('view')}
            >
              VIEW
            </Button>
            <Button
              type="button"
              variant={desktopContentTab === 'files' ? 'default' : 'outline'}
              size="default"
              className="h-full rounded-none border-y-0 border-l px-4"
              onClick={() => setDesktopContentTab('files')}
            >
              FILES ({availableFileCount})
            </Button>
          </div>
        )}
      </div>

      {downloadableFiles !== null && (
        <div className="lg:hidden flex-shrink-0 my-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={desktopContentTab === 'view' ? 'default' : 'outline'}
              size="sm"
              className="w-full"
              onClick={() => setDesktopContentTab('view')}
            >
              VIEW
            </Button>
            <Button
              type="button"
              variant={desktopContentTab === 'files' ? 'default' : 'outline'}
              size="sm"
              className="w-full"
              onClick={() => setDesktopContentTab('files')}
            >
              FILES ({availableFileCount})
            </Button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:gap-1 overflow-y-auto lg:overflow-hidden">
        {/* Video Sidebar */}
        <VideoSidebar
          videosByName={sidebarVideosByName}
          activeVideoName={activeVideoName}
          onVideoSelect={handleVideoSelect}
          albums={albums.map((a: any) => ({
            id: String(a.id),
            name: String(a.name || ''),
            photoCount: Number(a?._count?.photos || 0),
            thumbnailPhotoUrl: (a as any)?.thumbnailPhotoUrl || null,
          }))}
          activeAlbumId={activeAlbumId}
          onAlbumSelect={handleAlbumSelect}
          showVideos={project.enableVideos !== false}
          showAlbums={project.enablePhotos !== false}
          className="flex-shrink-0 h-[calc(100dvh-var(--admin-header-height))]"
          downloadableFiles={downloadableFiles}
          onDownloadFile={handleDownloadFile}
          onDownloadFiles={handleDownloadFiles}
          sharedDownloadProgress={transferSummary}
          isSharedDownloadActive={hasActiveTransfers}
          transferItems={transferItems}
          transferSummary={transferSummary}
          transferPanelVersion={transferPanelVersion}
          onCancelActiveTransfers={cancelActiveTransfers}
          onClearCompletedTransfers={clearCompletedTransfers}
          hasApprovableVideos={hasApprovableVideos}
          showDesktopTabBar={false}
          desktopActiveTab={desktopContentTab === 'files' ? 'files' : 'for-review'}
          onDesktopActiveTabChange={(tab) => setDesktopContentTab(tab === 'files' ? 'files' : 'view')}
          selectedFileIds={selectedFileIds}
          onSelectedFileIdsChange={setSelectedFileIds}
          activeFilesFolderName={requestedFilesFolderName}
        />

        {/* Main Content Area */}
        <div className={cn('flex-1 flex flex-col min-w-0 overflow-x-hidden', activeAlbumId ? 'overflow-hidden' : 'overflow-y-auto')}>
          <div
            className={cn(
              'w-full flex-1 min-h-0 flex flex-col',
              desktopContentTab === 'files'
                ? 'h-full'
                : 'px-4 sm:px-6 lg:px-8 py-4 sm:py-8'
            )}
          >
            {/* Main Content */}
            {desktopContentTab === 'files' ? (
              <ShareFilesBrowser
                groups={downloadableFiles || []}
                rootFolderLabel={String(project.title || 'PROJECT')}
                selectedFileIds={selectedFileIds}
                setSelectedFileIds={setSelectedFileIds}
                onDownloadFile={handleDownloadFile}
                onOpenVideoVersion={(file, folderName) => {
                  if (file.type !== 'video' || !file.videoId) return
                  if (folderName) {
                    handleVideoSelect(folderName)
                  }
                  setDesktopContentTab('view')
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId: file.videoId } }))
                    window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId: file.videoId } }))
                    window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: file.videoId, videoVersion: null } }))
                  }, 0)
                }}
                onDownloadFiles={handleDownloadFiles}
                sharedDownloadProgress={transferSummary}
                isSharedDownloadActive={hasActiveTransfers}
                onCloseFilesView={() => setDesktopContentTab('view')}
                requestedOpenFolderName={requestedFilesFolderName}
                onOpenFolderNameChange={setRequestedFilesFolderName}
                folderPreviewByName={folderPreviewByName}
                resolveFilePreviewUrl={resolveDownloadablePreviewUrl}
              />
            ) : activeAlbumId ? (
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
                      isPasswordProtected={(project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword}
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
                    onDraftGuardChange={(guard) => {
                      draftGuardRef.current = guard
                    }}
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
  onDraftGuardChange,
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
  onDraftGuardChange?: (guard: DraftNavigationGuard | null) => void
}) {
  const [isDesktop, setIsDesktop] = useState(false)
  const [commentsWidth, setCommentsWidth] = useState(420)
  const [isResizingComments, setIsResizingComments] = useState(false)

  const feedbackContainerRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!isDesktop) return
    const onResize = () => {
      // Clamp comments width so it never exceeds 60% of the viewport on resize.
      setCommentsWidth((prev) => {
        const max = Math.floor(window.innerWidth * 0.6)
        return prev > max ? max : prev
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [isDesktop])

  // Load saved sizes (desktop only)
  useEffect(() => {
    if (!isDesktop) return
    const savedWidth = localStorage.getItem('share_comments_width')
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (Number.isFinite(width) && width >= 380 && width <= window.innerWidth * 0.6) {
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
      const minWidth = 380
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
  }, [isResizingComments, commentsWidth])

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
    isPasswordProtected: (project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && Boolean(project.sharePassword),
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

  const resetDraft = useCallback(() => {
    management.resetDraft()
  }, [management])

  const { confirmNavigation } = useUnsavedChanges(management.hasUnsentComment, {
    message: UNSENT_COMMENT_MESSAGE,
    onDiscard: resetDraft,
  })

  const confirmDiscardDraft = useCallback(() => {
    if (!management.hasUnsentComment) {
      resetDraft()
      return true
    }

    return confirmNavigation()
  }, [confirmNavigation, management.hasUnsentComment, resetDraft])

  useEffect(() => {
    if (!onDraftGuardChange) return

    onDraftGuardChange({ confirmDiscardDraft })
    return () => onDraftGuardChange(null)
  }, [confirmDiscardDraft, onDraftGuardChange])

  const isApproved = project.status === 'APPROVED' || project.status === 'SHARE_ONLY'

  const latestVideoVersion = readyVideos.length > 0
    ? Math.max(...readyVideos.map((v: any) => v.version))
    : null

  const selectedVideo = readyVideos.find((v: any) => v.id === management.selectedVideoId)
  const selectedVideoApproved = selectedVideo ? Boolean(selectedVideo.approved) : false
  const anyApproved = readyVideos.some((v: any) => Boolean(v.approved))
  const commentsDisabled = Boolean(isApproved || selectedVideoApproved || anyApproved || !canManageShareComments)

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
              isPasswordProtected={(project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword}
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
              disableFullscreenCommentsUI={commentsDisabled}
              fillContainer
              pinControlsToBottom={false}
            />
          </div>

          {!commentsDisabled ? (
            <div className="mt-3 lg:hidden">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                onFileSelect={management.onFileSelect}
                attachedFiles={management.attachedFiles}
                onRemoveFile={management.onRemoveFile}
                allowFileUpload={true}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
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
              />
            </div>
          ) : null}
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
                }
              : undefined
          }
        >
          {/* Horizontal resize handle (desktop only) */}
          <div
            onMouseDown={startResizeComments}
            className="hidden lg:flex lg:items-center lg:justify-center absolute left-0 top-0 bottom-0 w-[5px] bg-transparent hover:bg-primary/15 cursor-col-resize select-none z-10 group transition-colors"
          >
            <div className="h-8 w-0.5 rounded-full bg-primary/45 opacity-0 group-hover:opacity-100 transition-opacity" />
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
              isPasswordProtected={(project.authMode === 'PASSWORD' || project.authMode === 'BOTH') && !!project.sharePassword}
              adminUser={adminUser}
              recipients={project.recipients || []}
              shareToken={null}
              showShortcutsButton={true}
              allowClientDeleteComments={project.allowClientDeleteComments}
              allowCommentFileUpload={true}
              hideInput={true}
              showApproveButton={false}
              largeAvatars={true}
              cardClassName={!commentsDisabled && isDesktop ? 'rounded-b-none' : undefined}
              management={management as any}
            />
          </div>

          {!commentsDisabled ? (
            <div className="hidden lg:block flex-shrink-0">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                onFileSelect={management.onFileSelect}
                attachedFiles={management.attachedFiles}
                onRemoveFile={management.onRemoveFile}
                allowFileUpload={true}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
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
                containerClassName="border border-border rounded-b-lg rounded-t-none border-t-0"
                showTopBorder={false}
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}
