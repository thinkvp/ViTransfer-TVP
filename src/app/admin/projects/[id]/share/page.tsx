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
import { ArrowLeft } from 'lucide-react'
import { apiFetch, attemptRefresh } from '@/lib/api-client'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { useTimeDisplayMode } from '@/hooks/useTimeDisplayMode'
import { useContentImageRefresh } from '@/hooks/useContentImageRefresh'
import { cn } from '@/lib/utils'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import type { DownloadQueueItem } from '@/lib/download-queue'
import { useDownloadTransfers } from '@/hooks/useDownloadTransfers'
import { calculateTransferSummary, createTransferId, isTransferActive, type TransferItem } from '@/lib/transfer-state'
import { getAccessToken } from '@/lib/token-store'
import { isS3Mode } from '@/lib/storage-provider-client'
import { extractUploadMediaMetadata } from '@/lib/upload-media-metadata-client'

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

type UploadAccessUrlCacheEntry = {
  downloadUrl: string | null
  playbackUrl: string | null
  previewUrl: string | null
  previewStatus: string | null
  expiresAt: number
}
const UPLOAD_ACCESS_URL_CACHE_TTL_MS = 45 * 1000

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
  const [desktopContentTab, setDesktopContentTab] = useState<'view' | 'files'>('files')
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [switchableProjects, setSwitchableProjects] = useState<AdminSwitchableProject[]>([])
  const [switchProjectsLoading, setSwitchProjectsLoading] = useState(false)
  const [switchProjectsError, setSwitchProjectsError] = useState<string | null>(null)
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null)
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null)
  const [headerVersionId, setHeaderVersionId] = useState<string | null>(null)
  const [requestedFilesFolderName, setRequestedFilesFolderName] = useState<string | null>(null)
  const [requestedFilesFileKey, setRequestedFilesFileKey] = useState<string | null>(null)
  const [uploadTransferItems, setUploadTransferItems] = useState<TransferItem[]>([])
  const [uploadTransferPanelVersion, setUploadTransferPanelVersion] = useState(0)
  const draftGuardRef = useRef<DraftNavigationGuard | null>(null)
  const uploadAbortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const uploadCancelRequestedRef = useRef(false)
  const lastFilesRefreshAtRef = useRef(0)
  const filesRefreshInFlightRef = useRef(false)
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const tokenRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const sidebarVideoCacheRef = useRef<Map<string, any>>(new Map())
  const sidebarThumbnailRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const sessionIdRef = useRef<string>(`admin:${Date.now()}`)
  // Coalesces per-video admin video-token requests (thumbnail/timeline) into one batch
  // POST instead of one GET per video. Keyed by `${videoId}:${quality}`.
  const videoTokenBatchRef = useRef<Map<string, { videoId: string; quality: string; resolve: (token: string | null) => void }>>(new Map())
  const videoTokenRequestRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const videoTokenBatchTimerRef = useRef<number | null>(null)
  // Coalesces per-file upload-access requests into one batch POST (matches the client
  // share page). Keyed by uploadFileId.
  const uploadAccessUrlCacheRef = useRef<Map<string, UploadAccessUrlCacheEntry>>(new Map())
  const uploadAccessUrlRequestCacheRef = useRef<Map<string, Promise<UploadAccessUrlCacheEntry | null>>>(new Map())
  const uploadAccessBatchRef = useRef<Map<string, { fileId: string; resolve: (value: UploadAccessUrlCacheEntry | null) => void }>>(new Map())
  const uploadAccessBatchTimerRef = useRef<number | null>(null)

  const isUploadsFilesBrowse = desktopContentTab === 'files'
    && String(requestedFilesFolderName || '').trim().startsWith('UPLOADS')
  const uploadsHeaderPath = isUploadsFilesBrowse ? String(requestedFilesFolderName || '').trim() : ''

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

  // Mobile browsers may animate focus auto-scroll when global smooth-scroll is enabled.
  // Keep share-page comment focus stable by disabling smooth scroll while this page is mounted.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const isMobileViewport = window.matchMedia('(max-width: 1023px)').matches
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches
    if (!isMobileViewport && !isCoarsePointer) return

    const root = document.documentElement
    const previous = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'

    return () => {
      root.style.scrollBehavior = previous
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

  // Fire the queued admin video-token requests as one batch POST and fan the tokens
  // back out to each waiting caller.
  const flushVideoTokenBatch = useCallback(async () => {
    videoTokenBatchTimerRef.current = null
    const entries = Array.from(videoTokenBatchRef.current.entries()) // [pairKey, { videoId, quality, resolve }]
    videoTokenBatchRef.current.clear()
    if (entries.length === 0) return

    const sessionId = sessionIdRef.current
    const items = entries.map(([, e]) => ({ videoId: e.videoId, quality: e.quality }))

    try {
      const response = await apiFetch('/api/admin/video-token/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: id, sessionId, items }),
      })
      if (!response.ok) {
        for (const [, e] of entries) e.resolve(null)
        return
      }
      const data = await response.json().catch(() => ({}))
      const results = (data && typeof (data as any).results === 'object' && (data as any).results) ? (data as any).results : {}
      // S3 mode returns presigned R2 URLs for thumbnails in `directUrls`; prefer those so the
      // <img> loads straight from R2. Callers detect a full URL (http…) vs a raw token.
      const directUrls = (data && typeof (data as any).directUrls === 'object' && (data as any).directUrls) ? (data as any).directUrls : {}
      for (const [pairKey, e] of entries) {
        const direct = directUrls[pairKey]
        const token = results[pairKey]
        const value = (typeof direct === 'string' && direct)
          ? direct
          : (typeof token === 'string' && token ? token : null)
        e.resolve(value)
      }
    } catch {
      for (const [, e] of entries) e.resolve(null)
    }
  }, [id])

  const getAdminVideoToken = useCallback((videoId: string, quality: string): Promise<string | null> => {
    if (!videoId || !quality) return Promise.resolve(null)
    const pairKey = `${videoId}:${quality}`

    const inFlight = videoTokenRequestRef.current.get(pairKey)
    if (inFlight) return inFlight

    const request = new Promise<string | null>((resolve) => {
      videoTokenBatchRef.current.set(pairKey, { videoId, quality, resolve })
    }).finally(() => {
      videoTokenRequestRef.current.delete(pairKey)
    })
    videoTokenRequestRef.current.set(pairKey, request)

    if (videoTokenBatchTimerRef.current == null) {
      videoTokenBatchTimerRef.current = window.setTimeout(() => {
        void flushVideoTokenBatch()
      }, 16)
    }
    return request
  }, [flushVideoTokenBatch])

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
              const thumbToken = await getAdminVideoToken(video.id, 'thumbnail')
              thumbnailUrl = thumbToken ? (thumbToken.startsWith('http') ? thumbToken : `/api/content/${thumbToken}`) : null
            }

            let timelineVttUrl = null
            let timelineSpriteUrl = null
            if (shouldFetchTimelinePreviews && video.timelinePreviewsReady) {
              const [vttToken, spriteToken] = await Promise.all([
                getAdminVideoToken(video.id, 'timeline-vtt'),
                getAdminVideoToken(video.id, 'timeline-sprite'),
              ])
              timelineVttUrl = vttToken ? `/api/content/${vttToken}` : null
              timelineSpriteUrl = spriteToken ? `/api/content/${spriteToken}` : null
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
  }, [id, project, getAdminVideoToken])

  const fetchSidebarVideos = useCallback(async (videos: any[]) => {
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
              const thumbToken = await getAdminVideoToken(video.id, 'thumbnail')
              thumbnailUrl = thumbToken ? (thumbToken.startsWith('http') ? thumbToken : `/api/content/${thumbToken}`) : null
            }

            let timelineVttUrl = null
            let timelineSpriteUrl = null
            if (shouldFetchTimelinePreviews && video.timelinePreviewsReady) {
              const [vttToken, spriteToken] = await Promise.all([
                getAdminVideoToken(video.id, 'timeline-vtt'),
                getAdminVideoToken(video.id, 'timeline-sprite'),
              ])
              timelineVttUrl = vttToken ? `/api/content/${vttToken}` : null
              timelineSpriteUrl = spriteToken ? `/api/content/${spriteToken}` : null
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
  }, [project?.timelinePreviewsEnabled, getAdminVideoToken])

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

  const requestFilesRefresh = useCallback((force = false) => {
    if (desktopContentTab !== 'files') return
    if (filesRefreshInFlightRef.current) return

    const now = Date.now()
    if (!force && now - lastFilesRefreshAtRef.current < 45_000) return

    filesRefreshInFlightRef.current = true
    lastFilesRefreshAtRef.current = now

    void fetchDownloadableFiles().finally(() => {
      filesRefreshInFlightRef.current = false
    })
  }, [desktopContentTab, fetchDownloadableFiles])

  // Fire the queued upload-access requests as one (chunked) batch POST and fan results
  // back to each waiting caller. Mirrors the client share page's batching.
  const flushUploadAccessBatch = useCallback(async () => {
    uploadAccessBatchTimerRef.current = null
    const items = Array.from(uploadAccessBatchRef.current.entries()) // [fileId, { fileId, resolve }]
    uploadAccessBatchRef.current.clear()
    if (items.length === 0) return

    const slug = project?.slug
    if (!slug) {
      for (const [, item] of items) item.resolve(null)
      return
    }

    const buildEntry = (data: any): UploadAccessUrlCacheEntry => ({
      downloadUrl: typeof data?.downloadUrl === 'string'
        ? data.downloadUrl
        : (typeof data?.url === 'string' ? data.url : null),
      playbackUrl: typeof data?.playbackUrl === 'string' && data.playbackUrl ? data.playbackUrl : null,
      previewUrl: typeof data?.previewUrl === 'string' && data.previewUrl ? data.previewUrl : null,
      previewStatus: typeof data?.previewStatus === 'string' ? data.previewStatus : null,
      expiresAt: Date.now() + UPLOAD_ACCESS_URL_CACHE_TTL_MS,
    })

    const uniqueFileIds = Array.from(new Set(items.map(([, item]) => item.fileId)))
    const CHUNK = 100
    const chunks: string[][] = []
    for (let i = 0; i < uniqueFileIds.length; i += CHUNK) {
      chunks.push(uniqueFileIds.slice(i, i + CHUNK))
    }

    const merged: Record<string, any> = {}
    let authFailed = false

    await Promise.all(chunks.map(async (chunkIds) => {
      try {
        const response = await apiFetch(`/api/share/${slug}/uploads/download-tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileIds: chunkIds }),
        })
        if (!response.ok) {
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            authFailed = true
          }
          return
        }
        const data = await response.json().catch(() => ({}))
        const results = (data && typeof (data as any).results === 'object' && (data as any).results)
          ? (data as any).results
          : {}
        Object.assign(merged, results)
      } catch {
        // Leave this chunk's files out of `merged` → they resolve null and can retry.
      }
    }))

    if (authFailed) requestFilesRefresh(true)

    for (const [fileId, item] of items) {
      uploadAccessUrlRequestCacheRef.current.delete(fileId)
      const raw = merged[item.fileId]
      if (!raw || typeof raw !== 'object') {
        item.resolve(null)
        continue
      }
      const entry = buildEntry(raw)
      uploadAccessUrlCacheRef.current.set(fileId, entry)
      item.resolve(entry)
    }
  }, [project?.slug, requestFilesRefresh])

  const getUploadAccessUrl = useCallback((fileId: string): Promise<UploadAccessUrlCacheEntry | null> => {
    const normalizedFileId = String(fileId || '').trim()
    if (!normalizedFileId || normalizedFileId.startsWith('pending-')) return Promise.resolve(null)

    const now = Date.now()
    const cached = uploadAccessUrlCacheRef.current.get(normalizedFileId)
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached)
    }

    const inFlight = uploadAccessUrlRequestCacheRef.current.get(normalizedFileId)
    if (inFlight) return inFlight

    const request = new Promise<UploadAccessUrlCacheEntry | null>((resolve) => {
      uploadAccessBatchRef.current.set(normalizedFileId, { fileId: normalizedFileId, resolve })
    })
    uploadAccessUrlRequestCacheRef.current.set(normalizedFileId, request)

    if (uploadAccessBatchTimerRef.current == null) {
      uploadAccessBatchTimerRef.current = window.setTimeout(() => {
        void flushUploadAccessBatch()
      }, 16)
    }

    return request
  }, [flushUploadAccessBatch])

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
    if (desktopContentTab !== 'files') return

    const onFocus = () => requestFilesRefresh(true)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestFilesRefresh(true)
      }
    }

    const intervalId = window.setInterval(() => {
      requestFilesRefresh(false)
    }, 2 * 60 * 1000)

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)

    requestFilesRefresh(true)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [desktopContentTab, requestFilesRefresh])

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
      const detail = (event as CustomEvent<{ folderName?: string; fileKey?: string }>).detail
      const folderName = String(detail?.folderName || '').trim()
      const fileKey = String(detail?.fileKey || '').trim()
      setDesktopContentTab('files')
      if (folderName) {
        setRequestedFilesFolderName(folderName)
      }
      setRequestedFilesFileKey(fileKey || null)
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

  // True when the project has at least one video or album to show in VIEW mode.
  const hasViewContent = useMemo(() => {
    if (!project) return true
    const hasVideos = project.enableVideos !== false &&
      project.videosByName &&
      Object.keys(project.videosByName).length > 0
    if (hasVideos) return true
    if (albumsLoading) return true
    return project.enablePhotos !== false && albums.length > 0
  }, [project, albumsLoading, albums])

  // Auto-switch to FILES mode when there is nothing to show in VIEW mode.
  useEffect(() => {
    if (!project || albumsLoading) return
    if (!hasViewContent) {
      setDesktopContentTab('files')
    }
  }, [project, albumsLoading, hasViewContent])

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
        let shouldOpenPlayer = false

        if (urlVideoName && project.videosByName[urlVideoName]) {
          // Deep link → open the player.
          videoNameToUse = urlVideoName
          shouldOpenPlayer = true
        } else {
          const savedVideoName = sessionStorage.getItem('approvedVideoName')
          if (savedVideoName) {
            sessionStorage.removeItem('approvedVideoName')
            if (project.videosByName[savedVideoName]) {
              videoNameToUse = savedVideoName
            }
          }
        }

        // Rest on the Files browser at the project root with nothing selected — do
        // not auto-select the first video for the combined files view.
        if (!videoNameToUse) return

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        setActiveVideosRaw(videos)

        // Keep the sidebar highlight and Files browser folder in sync.
        if (!shouldOpenPlayer) {
          setRequestedFilesFolderName(videoNameToUse)
        }

        if (urlVersion !== null && videos) {
          const targetIndex = videos.findIndex((v: any) => v.version === urlVersion)
          if (targetIndex !== -1) {
            setInitialVideoIndex(targetIndex)
          }
        }

        if (urlTimestamp !== null) {
          setInitialSeekTime(urlTimestamp)
        }

        if (shouldOpenPlayer) {
          setDesktopContentTab('view')
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

  // ── Comprehensive content-token refresh ──────────────────────────────────
  // Called by useContentImageRefresh on: image load errors, periodic timer,
  // and visibility change (tab hidden >30 s → visible).  Covers video
  // thumbnails/sprites, album photos, and upload previews.
  const refreshAllContentTokens = useCallback(() => {
    // Clear all token caches so subsequent fetches produce fresh URLs.
    tokenCacheRef.current.clear()
    tokenRequestCacheRef.current.clear()
    sidebarVideoCacheRef.current.clear()
    sidebarThumbnailRequestCacheRef.current.clear()

    // Refresh video tokens (thumbnails, sprites, VTT) for all videos.
    if (project?.videosByName) {
      const allVideos = Object.values(project.videosByName).flat() as any[]
      if (allVideos.length > 0) {
        void fetchSidebarVideos(allVideos).then((tokenized) => {
          setAllVideosByName((prev) => {
            const updated = { ...prev }
            tokenized.forEach((video: any) => {
              const videoName = Object.entries(project.videosByName).find(
                ([_, versions]: any) => (versions as any[]).some((v: any) => v.id === video.id)
              )?.[0]
              if (videoName) {
                if (!updated[videoName]) updated[videoName] = []
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

          // Also re-tokenize the active video for the player.
          if (activeVideoName && project.videosByName[activeVideoName]) {
            void fetchTokensForVideos(project.videosByName[activeVideoName]).then((tokenizedActive) => {
              setActiveVideos(tokenizedActive)
            })
          }
        })
      }
    }

    // Refresh downloadable files (album photo tokens, upload access URLs).
    void fetchDownloadableFiles()

    // Refresh album list (sidebar album thumbnail URLs).
    if (project?.slug) {
      void fetchAlbums(String(project.slug))
    }
  }, [project?.videosByName, project?.slug, activeVideoName, fetchSidebarVideos, fetchTokensForVideos, fetchDownloadableFiles, fetchAlbums])

  // Global content-image error capture + proactive periodic token refresh +
  // visibility-change refresh.
  useContentImageRefresh({
    onRefresh: refreshAllContentTokens,
    enabled: !loading && !!project,
  })

  // Set a video as the active folder without toggling — used by the version-open
  // path (opening a specific version from the Files browser), which then switches
  // the right panel to the player.
  const activateVideoFolder = (videoName: string) => {
    setActiveAlbumId(null)
    setActiveVideoName(videoName)
    if (project?.videosByName?.[videoName]) {
      setActiveVideosRaw(project.videosByName[videoName])
    }
  }

  // Handle video selection from the sidebar. Selecting an item navigates the Files
  // browser to that folder; selecting the already-active item deselects it back to
  // the project root.
  const handleVideoSelect = (videoName: string) => {
    if (!confirmShareDraftNavigation()) return
    const isAlreadyActive = !activeAlbumId && activeVideoName === videoName && desktopContentTab === 'files'
    if (isAlreadyActive) {
      setActiveVideoName('')
      setActiveVideosRaw([])
      setRequestedFilesFolderName(null)
      return
    }
    setActiveAlbumId(null)
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
    setRequestedFilesFolderName(videoName)
    setDesktopContentTab('files')
  }

  const handleAlbumSelect = (albumId: string) => {
    if (!confirmShareDraftNavigation()) return
    const album = albums.find((a: any) => String(a.id) === String(albumId))
    const isAlreadyActive = activeAlbumId === albumId && desktopContentTab === 'files'
    if (isAlreadyActive) {
      setActiveAlbumId(null)
      setRequestedFilesFolderName(null)
      return
    }
    setActiveVideoName('')
    setActiveVideosRaw([])
    setActiveAlbumId(albumId)
    setRequestedFilesFolderName(String(album?.name || ''))
    setDesktopContentTab('files')
  }

  // Toggle the UPLOADS folder in the Files browser (UPLOADS ⇄ project root).
  const handleUploadsSelect = () => {
    if (!confirmShareDraftNavigation()) return
    const isAlreadyActive = desktopContentTab === 'files'
      && String(requestedFilesFolderName || '').trim().startsWith('UPLOADS')
    if (isAlreadyActive) {
      setRequestedFilesFolderName(null)
      return
    }
    setActiveVideoName('')
    setActiveVideosRaw([])
    setActiveAlbumId(null)
    setRequestedFilesFolderName('UPLOADS')
    setDesktopContentTab('files')
  }

  // Files browser navigated to a folder (user clicked/opened it inside the right
  // panel). Mirror that into the sidebar selection so the two stay correlated.
  const handleFilesFolderChange = useCallback((folderName: string | null) => {
    setRequestedFilesFolderName(folderName)
    const name = String(folderName || '').trim()
    if (!name || name.startsWith('UPLOADS')) {
      setActiveVideoName('')
      setActiveVideosRaw([])
      setActiveAlbumId(null)
      return
    }
    const album = albums.find((a: any) => String(a?.name || '') === name)
    if (album) {
      setActiveVideoName('')
      setActiveVideosRaw([])
      setActiveAlbumId(String(album.id))
      return
    }
    if (project?.videosByName?.[name]) {
      setActiveAlbumId(null)
      setActiveVideoName(name)
      setActiveVideosRaw(project.videosByName[name])
      return
    }
    setActiveVideoName('')
    setActiveVideosRaw([])
    setActiveAlbumId(null)
  }, [albums, project?.videosByName])

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
      } else if (file.type === 'upload-file') {
        const r = await apiFetch(`/api/share/${project?.slug}/uploads/download-token`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: file.uploadFileId }),
        })
        const data = await r.json()
        url = data.downloadUrl || data.url
      } else {
        if (!file.downloadUrl) return null
        url = file.downloadUrl
      }
      if (!url || typeof url !== 'string') return null
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

  const handleCreateUploadFolder = useCallback(async (parentPath: string, folderName: string) => {
    if (!project?.slug) throw new Error('Project share link is unavailable')

    const response = await apiFetch(`/api/share/${project.slug}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentPath,
        folderName,
      }),
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(String((payload as any)?.error || 'Unable to create folder'))
    }

    await fetchDownloadableFiles()
  }, [fetchDownloadableFiles, project?.slug])

  const handleApproveVideo = useCallback(async (file: DownloadableFile) => {
    if (!file.videoId) throw new Error('Video ID is missing')
    if (!id) throw new Error('Project not loaded')

    const url = `/api/projects/${id}/approve`
    const response = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVideoId: file.videoId }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to approve video')
    }

    markVideoApproved(file.videoId)
    window.dispatchEvent(new CustomEvent('videoApprovalChanged', { detail: { videoId: file.videoId } }))
    void fetchDownloadableFiles()
  }, [id, markVideoApproved, fetchDownloadableFiles])

  const handleUploadFiles = useCallback(async (folderPath: string, files: File[]) => {
    if (!project?.slug) throw new Error('Project share link is unavailable')
    if (!Array.isArray(files) || files.length === 0) return
    uploadCancelRequestedRef.current = false

    const useS3Multipart = await isS3Mode()

    const performRequest = async (
      url: string,
      init: RequestInit,
      retryOn401: boolean,
    ): Promise<Response> => {
      const withAccessToken = (token: string | null) => {
        const authHeader: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
        return apiFetch(url, {
          ...init,
          headers: {
            ...authHeader,
            ...(init.headers as Record<string, string> | undefined),
          },
        })
      }

      let response = await withAccessToken(getAccessToken())

      if (retryOn401 && response.status === 401) {
        const refreshed = await attemptRefresh()
        if (refreshed) {
          response = await withAccessToken(getAccessToken())
        }
      }

      return response
    }

    const queuedItems: TransferItem[] = files.map((file) => ({
      id: createTransferId('upload'),
      direction: 'upload',
      kind: 'file',
      fileName: file.name,
      uploadFolderPath: folderPath,
      progressPercent: 0,
      status: 'queued',
      fileSizeBytes: file.size,
      speedBytesPerSecond: null,
      etaSeconds: null,
      errorMessage: null,
    }))

    setDownloadableFiles((prev) => {
      const targetGroupName = folderPath ? `UPLOADS / ${folderPath}` : 'UPLOADS'
      const optimisticFiles: DownloadableFile[] = files.map((file, index) => ({
        type: 'upload-file',
        uploadFileId: `pending-${queuedItems[index].id}`,
        uploadFolderPath: folderPath,
        fileName: file.name,
        fileSizeBytes: file.size,
      }))

      if (!Array.isArray(prev)) {
        return [
          {
            name: targetGroupName,
            groupType: 'uploads',
            subFiles: optimisticFiles,
          },
        ]
      }

      const existingGroupIndex = prev.findIndex((group) => group.groupType === 'uploads' && group.name === targetGroupName)
      if (existingGroupIndex === -1) {
        return [
          ...prev,
          {
            name: targetGroupName,
            groupType: 'uploads',
            subFiles: optimisticFiles,
          },
        ]
      }

      return prev.map((group, index) => {
        if (index !== existingGroupIndex) return group
        return {
          ...group,
          subFiles: [...group.subFiles, ...optimisticFiles],
        }
      })
    })

    setUploadTransferPanelVersion((value) => value + 1)
    setUploadTransferItems((prev) => [...prev, ...queuedItems])

    let firstFailure: Error | null = null

    for (let index = 0; index < files.length; index += 1) {
      if (uploadCancelRequestedRef.current) {
        setUploadTransferItems((prev) => prev.map((item) => (
          ['queued', 'preparing', 'transferring'].includes(item.status)
            ? { ...item, status: 'canceled', errorMessage: 'Canceled' }
            : item
        )))
        break
      }

      const file = files[index]
      const transferId = queuedItems[index].id
      const transferStartedAtMs = Date.now()
      let shouldStopProcessing = false

      const speedState = {
        lastLoadedBytes: 0,
        lastTimestampMs: transferStartedAtMs,
        smoothedSpeedBytesPerSecond: null as number | null,
      }

      const calculateUploadMetrics = (loadedBytes: number) => {
        const now = Date.now()
        const elapsedSeconds = Math.max((now - transferStartedAtMs) / 1000, 0)
        const deltaBytes = Math.max(loadedBytes - speedState.lastLoadedBytes, 0)
        const deltaSeconds = Math.max((now - speedState.lastTimestampMs) / 1000, 0)

        if (deltaBytes > 0 && deltaSeconds >= 0.2) {
          const instantSpeed = deltaBytes / deltaSeconds
          speedState.smoothedSpeedBytesPerSecond = speedState.smoothedSpeedBytesPerSecond == null
            ? instantSpeed
            : (speedState.smoothedSpeedBytesPerSecond * 0.7) + (instantSpeed * 0.3)
          speedState.lastLoadedBytes = loadedBytes
          speedState.lastTimestampMs = now
        }

        const stableSpeed = elapsedSeconds >= 1.5
          ? speedState.smoothedSpeedBytesPerSecond
          : null
        const remainingBytes = Math.max(file.size - loadedBytes, 0)
        const etaSeconds = stableSpeed && stableSpeed > 0
          ? remainingBytes / stableSpeed
          : null

        return {
          speedBytesPerSecond: stableSpeed,
          etaSeconds,
        }
      }

      setUploadTransferItems((prev) => prev.map((item) => (
        item.id === transferId
          ? {
              ...item,
              status: 'preparing',
              progressPercent: 0,
              speedBytesPerSecond: null,
              etaSeconds: null,
              errorMessage: null,
            }
          : item
      )))

      const controller = new AbortController()
      uploadAbortControllersRef.current.set(transferId, controller)

      try {
        const mediaMetadata = await extractUploadMediaMetadata(file).catch(() => null)

        if (useS3Multipart) {
          const presignRes = await performRequest(
            `/api/share/${project.slug}/uploads/s3/presign`,
            {
              method: 'POST',
              signal: controller.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                fileName: file.name,
                fileSize: file.size,
                contentType: file.type || 'application/octet-stream',
                folderPath,
              }),
            },
            true,
          )

          if (!presignRes.ok) {
            const payload = await presignRes.json().catch(() => null)
            throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Upload failed')
          }

          const presignPayload = await presignRes.json()
          const uploadId = String(presignPayload?.uploadId || '')
          const key = String(presignPayload?.key || '')
          const parts = Array.isArray(presignPayload?.parts) ? presignPayload.parts : []
          const partSize = Number(presignPayload?.partSize || 0)

          if (!uploadId || !key || !Array.isArray(parts) || parts.length === 0 || !Number.isFinite(partSize) || partSize <= 0) {
            throw new Error('Upload presign response was invalid')
          }

          let totalSentBytes = 0
          let nextPartIdx = 0
          const completedParts: Array<{ partNumber: number; etag: string }> = new Array(parts.length)
          const maxConcurrent = Math.min(4, parts.length)

          const patchProgress = () => {
            const progress = Math.floor((totalSentBytes / Math.max(file.size, 1)) * 100)
            const metrics = calculateUploadMetrics(totalSentBytes)
            setUploadTransferItems((prev) => prev.map((item) => (
              item.id === transferId
                ? {
                    ...item,
                    status: 'transferring',
                    progressPercent: Math.min(99, Math.max(progress, item.progressPercent)),
                    speedBytesPerSecond: metrics.speedBytesPerSecond,
                    etaSeconds: metrics.etaSeconds,
                    errorMessage: null,
                  }
                : item
            )))
          }

          const uploadPart = async (part: any, chunk: Blob, chunkBytes: number): Promise<string> => {
            const url = String(part?.url || '')
            if (!url) throw new Error('Missing multipart URL')

            return await new Promise<string>((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'))
                return
              }

              const xhr = new XMLHttpRequest()
              xhr.open('PUT', url)
              let lastLoaded = 0

              xhr.upload.addEventListener('progress', (event) => {
                const delta = event.loaded - lastLoaded
                if (delta <= 0) return
                lastLoaded = event.loaded
                totalSentBytes = Math.min(totalSentBytes + delta, file.size)
                patchProgress()
              })

              xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  const tail = chunkBytes - lastLoaded
                  if (tail > 0) {
                    totalSentBytes = Math.min(totalSentBytes + tail, file.size)
                    patchProgress()
                  }
                  const etag = xhr.getResponseHeader('ETag') ?? xhr.getResponseHeader('etag')
                  if (!etag) {
                    reject(new Error('Part upload succeeded but no ETag returned'))
                    return
                  }
                  resolve(etag)
                  return
                }

                reject(new Error(`Part upload failed with status ${xhr.status}`))
              })

              xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
              xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))

              const unsubscribe = () => xhr.abort()
              controller.signal.addEventListener('abort', unsubscribe, { once: true })
              xhr.addEventListener('loadend', () => controller.signal.removeEventListener('abort', unsubscribe))
              xhr.send(chunk)
            })
          }

          const worker = async () => {
            while (nextPartIdx < parts.length) {
              const i = nextPartIdx++
              const part = parts[i]
              const start = i * partSize
              const end = Math.min(start + partSize, file.size)
              const chunk = file.slice(start, end)
              const chunkBytes = end - start
              const etag = await uploadPart(part, chunk, chunkBytes)
              completedParts[i] = { partNumber: Number(part?.partNumber || i + 1), etag }
            }
          }

          try {
            await Promise.all(Array.from({ length: maxConcurrent }, () => worker()))
          } catch (error) {
            await performRequest(
              `/api/share/${project.slug}/uploads/s3/abort`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uploadId, key }),
              },
              false,
            ).catch(() => undefined)
            throw error
          }

          const completeRes = await performRequest(
            `/api/share/${project.slug}/uploads/s3/complete`,
            {
              method: 'POST',
              signal: controller.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uploadId,
                key,
                parts: completedParts,
                fileSize: file.size,
                fileName: file.name,
                fileType: file.type || 'application/octet-stream',
                folderPath,
                mediaMetadata,
              }),
            },
            true,
          )

          if (!completeRes.ok) {
            const payload = await completeRes.json().catch(() => null)
            throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Upload failed')
          }
        } else {
          const formData = new FormData()
          formData.append('file', file)
          formData.append('folderPath', folderPath)
          if (mediaMetadata) {
            formData.append('mediaMetadata', JSON.stringify(mediaMetadata))
          }

          const uploadWithProgress = (accessToken: string | null): Promise<{ status: number; responseText: string }> => {
            return new Promise((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'))
                return
              }

              const xhr = new XMLHttpRequest()
              xhr.open('POST', `/api/share/${project.slug}/uploads/files`)
              if (accessToken) {
                xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
              }

              xhr.upload.addEventListener('progress', (event) => {
                if (!event.lengthComputable) return
                const progress = Math.floor((event.loaded / Math.max(file.size, 1)) * 100)
                const metrics = calculateUploadMetrics(event.loaded)
                setUploadTransferItems((prev) => prev.map((item) => (
                  item.id === transferId
                    ? {
                        ...item,
                        status: 'transferring',
                        progressPercent: Math.min(99, Math.max(progress, item.progressPercent)),
                        speedBytesPerSecond: metrics.speedBytesPerSecond,
                        etaSeconds: metrics.etaSeconds,
                        errorMessage: null,
                      }
                    : item
                )))
              })

              xhr.addEventListener('load', () => {
                resolve({ status: xhr.status, responseText: xhr.responseText || '' })
              })

              xhr.addEventListener('error', () => reject(new Error('Network error during upload')))
              xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))

              const unsubscribe = () => xhr.abort()
              controller.signal.addEventListener('abort', unsubscribe, { once: true })
              xhr.addEventListener('loadend', () => controller.signal.removeEventListener('abort', unsubscribe))

              setUploadTransferItems((prev) => prev.map((item) => (
                item.id === transferId
                  ? { ...item, status: 'transferring', progressPercent: Math.max(10, item.progressPercent), errorMessage: null }
                  : item
              )))

              xhr.send(formData)
            })
          }

          let uploadResult = await uploadWithProgress(getAccessToken())

          if (uploadResult.status === 401) {
            const refreshed = await attemptRefresh()
            if (refreshed) {
              uploadResult = await uploadWithProgress(getAccessToken())
            }
          }

          if (uploadResult.status < 200 || uploadResult.status >= 300) {
            let errorMessage = `Unable to upload ${file.name}`
            try {
              const payload = JSON.parse(uploadResult.responseText || '{}')
              if (payload && typeof payload.error === 'string' && payload.error.trim()) {
                errorMessage = payload.error
              }
            } catch {
              // Keep default message when response is not JSON.
            }
            throw new Error(errorMessage)
          }
        }

        setUploadTransferItems((prev) => prev.map((item) => (
          item.id === transferId
            ? {
                ...item,
                status: 'completed',
                progressPercent: 100,
                speedBytesPerSecond: null,
                etaSeconds: null,
                errorMessage: null,
              }
            : item
        )))
      } catch (error) {
        const wasCanceled = error instanceof DOMException && error.name === 'AbortError'
        setUploadTransferItems((prev) => prev.map((item) => (
          item.id === transferId
            ? {
                ...item,
                status: wasCanceled ? 'canceled' : 'failed',
                progressPercent: wasCanceled ? item.progressPercent : 100,
                speedBytesPerSecond: null,
                etaSeconds: null,
                errorMessage: wasCanceled
                  ? 'Canceled'
                  : (error instanceof Error ? error.message : 'Upload failed'),
              }
            : item
        )))

        if (!wasCanceled) {
          if (!firstFailure) {
            firstFailure = error instanceof Error ? error : new Error('Upload failed')
          }
          continue
        }

        shouldStopProcessing = uploadCancelRequestedRef.current
      } finally {
        uploadAbortControllersRef.current.delete(transferId)
      }

      if (shouldStopProcessing) {
        break
      }
    }

    await fetchDownloadableFiles()

    if (firstFailure) {
      throw firstFailure
    }
  }, [fetchDownloadableFiles, project?.slug])

  const handleDeleteUploadFile = useCallback(async (fileId: string) => {
    if (!project?.slug) throw new Error('Project share link is unavailable')

    const response = await apiFetch(`/api/share/${project.slug}/uploads?fileId=${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(String((payload as any)?.error || 'Unable to delete file'))
    }

    await fetchDownloadableFiles()
  }, [fetchDownloadableFiles, project?.slug])

  const handleDeleteUploadFolder = useCallback(async (folderPath: string) => {
    if (!project?.slug) throw new Error('Project share link is unavailable')

    const response = await apiFetch(`/api/share/${project.slug}/uploads?folderPath=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(String((payload as any)?.error || 'Unable to delete folder'))
    }

    await fetchDownloadableFiles()
  }, [fetchDownloadableFiles, project?.slug])

  const handleRenameUploadFolder = useCallback(async (folderPath: string, folderName: string) => {
    if (!project?.slug) throw new Error('Project share link is unavailable')

    const response = await apiFetch(`/api/share/${project.slug}/uploads`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, folderName }),
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(String((payload as any)?.error || 'Unable to rename folder'))
    }

    await fetchDownloadableFiles()
  }, [fetchDownloadableFiles, project?.slug])

  const transferItemsCombined = useMemo(() => {
    return [...transferItems, ...uploadTransferItems]
  }, [transferItems, uploadTransferItems])

  const optimisticUploadRowsSignature = useMemo(() => {
    return uploadTransferItems
      .filter((item) => item.status !== 'failed' && item.status !== 'canceled')
      .map((item) => [
        item.id,
        item.status,
        item.fileName,
        String(item.uploadFolderPath || ''),
        String(item.fileSizeBytes ?? ''),
      ].join(':'))
      .join('|')
  }, [uploadTransferItems])

  const optimisticUploadRows = useMemo(() => {
    return uploadTransferItems.filter((item) => item.status !== 'failed' && item.status !== 'canceled')
    // Recompute only when row identity/status changes, not on frequent progress ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimisticUploadRowsSignature])

  const downloadableFilesWithOptimisticUploads = useMemo<DownloadableGroup[]>(() => {
    const baseGroups = Array.isArray(downloadableFiles) ? downloadableFiles : []
    if (optimisticUploadRows.length === 0) return baseGroups

    const nextGroups = baseGroups.map((group) => ({ ...group, subFiles: [...group.subFiles] }))
    const groupIndexByName = new Map(nextGroups.map((group, index) => [group.name, index]))

    for (const item of optimisticUploadRows) {
      const folderPath = String(item.uploadFolderPath || '').trim()
      const groupName = folderPath ? `UPLOADS / ${folderPath}` : 'UPLOADS'
      const optimisticFile: DownloadableFile = {
        type: 'upload-file',
        uploadFileId: `pending-${item.id}`,
        uploadFolderPath: folderPath,
        fileName: item.fileName,
        fileSizeBytes: typeof item.fileSizeBytes === 'number' ? item.fileSizeBytes : undefined,
      }

      let groupIndex = groupIndexByName.get(groupName)
      if (groupIndex == null) {
        groupIndex = nextGroups.length
        nextGroups.push({
          name: groupName,
          groupType: 'uploads',
          subFiles: [],
        })
        groupIndexByName.set(groupName, groupIndex)
      }

      const group = nextGroups[groupIndex]
      const hasMatchingPersistedUpload = group.subFiles.some((file) => {
        if (file.type !== 'upload-file') return false
        if (String(file.uploadFileId || '').startsWith('pending-')) return false
        if (file.fileName !== item.fileName) return false

        const serverSize = typeof file.fileSizeBytes === 'string' ? Number(file.fileSizeBytes) : file.fileSizeBytes
        const optimisticSize = typeof item.fileSizeBytes === 'number' ? item.fileSizeBytes : null
        if (optimisticSize == null) return true
        return Number.isFinite(serverSize as number) && Number(serverSize) === optimisticSize
      })

      if (item.status === 'completed' && hasMatchingPersistedUpload) {
        continue
      }

      if (!group.subFiles.some((file) => file.uploadFileId === optimisticFile.uploadFileId)) {
        group.subFiles.push(optimisticFile)
      }
    }

    return nextGroups
  }, [downloadableFiles, optimisticUploadRows])

  const transferSummaryCombined = useMemo(() => {
    return calculateTransferSummary(transferItemsCombined)
  }, [transferItemsCombined])

  const hasAnyActiveTransfers = useMemo(() => {
    return transferItemsCombined.some((item) => isTransferActive(item.status))
  }, [transferItemsCombined])

  const clearCompletedTransfersCombined = useCallback(() => {
    clearCompletedTransfers()
    setUploadTransferItems((prev) => prev.filter((item) => isTransferActive(item.status)))
  }, [clearCompletedTransfers])

  const cancelActiveTransfersCombined = useCallback(() => {
    uploadCancelRequestedRef.current = true
    cancelActiveTransfers()
    setUploadTransferItems((prev) => prev.map((item) => (
      ['queued', 'preparing', 'transferring'].includes(item.status)
        ? { ...item, status: 'canceled', errorMessage: 'Canceled' }
        : item
    )))
    uploadAbortControllersRef.current.forEach((controller) => {
      controller.abort()
    })
  }, [cancelActiveTransfers])

  const transferPanelVersionCombined = transferPanelVersion + uploadTransferPanelVersion

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

    if (file.type === 'upload-file' && file.uploadFileId && project?.slug) {
      if (file.uploadFileId.startsWith('pending-')) {
        return null
      }

      const entry = await getUploadAccessUrl(file.uploadFileId)
      // Do not fall back to downloadUrl — videos without a ready preview should show the icon fallback
      return entry?.previewUrl || null
    }

    if (file.type === 'video' && file.videoId) {
      return filePreviewByVideoId.get(file.videoId) || null
    }

    if (file.type !== 'asset' || !file.videoId || !file.assetId) return null

    try {
      const response = await apiFetch(`/api/videos/${file.videoId}/assets/${file.assetId}/download-token`, {
        method: 'POST',
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          requestFilesRefresh(true)
        }
        return null
      }
      const data = await response.json().catch(() => ({}))
      if (typeof (data as any)?.previewUrl === 'string' && (data as any).previewUrl) {
        return String((data as any).previewUrl)
      }
      return null
    } catch {
      return null
    }
  }, [filePreviewByVideoId, project?.slug, requestFilesRefresh, getUploadAccessUrl])

  // Resolve up to 3 preview thumbnails for the sidebar UPLOADS folder mosaic, so the
  // entry matches the FILES browser root folder card. Mirrors ShareFilesBrowser's
  // per-folder tile resolution but across all uploads groups.
  const [uploadsPreviewTiles, setUploadsPreviewTiles] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    async function resolveUploadsTiles() {
      const uploadGroups = (downloadableFilesWithOptimisticUploads || []).filter((group) => group.groupType === 'uploads')
      if (uploadGroups.length === 0) {
        setUploadsPreviewTiles([])
        return
      }
      const candidates = uploadGroups
        .flatMap((group) => [...(group.mainFile ? [group.mainFile] : []), ...group.subFiles])
        .filter((file) => {
          const kind = getDownloadableFileKind(file)
          return kind === 'image' || kind === 'video'
        })
        .slice(0, 12)

      const urls: string[] = []
      for (const file of candidates) {
        const url = await resolveDownloadablePreviewUrl(file).catch(() => null)
        if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
          urls.push(url)
          if (urls.length >= 3) break
        }
      }
      if (!cancelled) setUploadsPreviewTiles(urls)
    }
    void resolveUploadsTiles()
    return () => { cancelled = true }
    // Re-resolves whenever the files list refreshes (focus/visibility/interval), which
    // also recovers expired preview tokens — so the mosaic needs no error-retry loop.
  }, [downloadableFilesWithOptimisticUploads, resolveDownloadablePreviewUrl])

  const resolveDownloadablePlaybackUrl = useCallback(async (file: DownloadableFile): Promise<string | null> => {
    if (file.type === 'upload-file' && file.uploadFileId && project?.slug) {
      const entry = await getUploadAccessUrl(file.uploadFileId)
      return entry?.playbackUrl || entry?.downloadUrl || null
    }

    if (file.type !== 'asset' || !file.videoId || !file.assetId) return null

    try {
      const response = await apiFetch(`/api/videos/${file.videoId}/assets/${file.assetId}/download-token`, {
        method: 'POST',
      })
      if (!response.ok) return null
      const data = await response.json().catch(() => ({}))
      if (typeof (data as any)?.playbackUrl === 'string' && (data as any).playbackUrl) {
        return String((data as any).playbackUrl)
      }
      return null
    } catch {
      return null
    }
  }, [project?.slug, getUploadAccessUrl])

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
      <div className="flex-shrink-0 h-12 my-[2px] border border-border bg-card rounded-lg flex items-center pl-4 pr-3 lg:pr-0 gap-1.5 text-sm overflow-x-auto z-40">

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

        {isUploadsFilesBrowse ? (
          <>
            <span className="text-muted-foreground flex-shrink-0">/</span>
            <span
              className="text-foreground whitespace-nowrap flex-shrink-0 max-w-[40%] truncate"
              title={uploadsHeaderPath}
            >
              {uploadsHeaderPath}
            </span>
          </>
        ) : null}

        {/* Video / Album section */}
        {(activeVideoName || activeAlbumId) && !isUploadsFilesBrowse && !(desktopContentTab === 'files' && !requestedFilesFolderName) && (
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
            {isOlderVersionSelected && (
              <span className="text-amber-600 dark:text-amber-400 text-xs whitespace-nowrap flex-shrink-0">(Newer version available)</span>
            )}
          </>
        )}

        <span className="w-2 flex-shrink-0 lg:hidden" aria-hidden="true" />
      </div>

      {/* Content */}
      <div className={cn(
        'flex-1 min-h-0 flex flex-col lg:flex-row lg:gap-1 overflow-y-auto lg:overflow-hidden',
        desktopContentTab === 'files' ? 'gap-2 lg:gap-1' : 'gap-0'
      )}>
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
          downloadableFiles={downloadableFilesWithOptimisticUploads}
          onDownloadFile={handleDownloadFile}
          onDownloadFiles={handleDownloadFiles}
          sharedDownloadProgress={transferSummaryCombined}
          isSharedDownloadActive={hasAnyActiveTransfers}
          transferItems={transferItemsCombined}
          transferSummary={transferSummaryCombined}
          transferPanelVersion={transferPanelVersionCombined}
          onCancelActiveTransfers={cancelActiveTransfersCombined}
          onClearCompletedTransfers={clearCompletedTransfersCombined}
          hasApprovableVideos={hasApprovableVideos}
          showDesktopTabBar={false}
          desktopActiveTab="for-review"
          showUploadsInView
          onUploadsSelect={handleUploadsSelect}
          uploadsPreviewTiles={uploadsPreviewTiles}
          selectedFileIds={selectedFileIds}
          onSelectedFileIdsChange={setSelectedFileIds}
          activeFilesFolderName={requestedFilesFolderName}
          shareSlug={String(project.slug)}
          canDeleteUploads={true}
          onDeleteUploadFile={handleDeleteUploadFile}
          onDeleteUploadFolder={handleDeleteUploadFolder}
          onRenameUploadFolder={handleRenameUploadFolder}
          onOpenVideoVersion={(file, folderName) => {
            if (file.type !== 'video' || !file.videoId) return
            if (folderName) {
              activateVideoFolder(folderName)
            }
            setDesktopContentTab('view')
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId: file.videoId } }))
              window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId: file.videoId } }))
              window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: file.videoId, videoVersion: null } }))
            }, 0)
          }}
          onApproveVideo={handleApproveVideo}
        />

        {/* Main Content Area */}
        <div
          className={cn(
            'flex-1 flex flex-col min-w-0 overflow-x-hidden lg:h-[calc(100dvh-var(--admin-header-height))] lg:overflow-hidden',
            activeAlbumId ? 'overflow-hidden' : 'overflow-y-auto',
            desktopContentTab === 'files' ? 'mt-2 lg:mt-0' : ''
          )}
        >
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
                groups={downloadableFilesWithOptimisticUploads}
                rootFolderLabel={String(project.title || 'PROJECT')}
                selectedFileIds={selectedFileIds}
                setSelectedFileIds={setSelectedFileIds}
                onDownloadFile={handleDownloadFile}
                onOpenVideoVersion={(file, folderName) => {
                  if (file.type !== 'video' || !file.videoId) return
                  if (folderName) {
                    activateVideoFolder(folderName)
                  }
                  setDesktopContentTab('view')
                  setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId: file.videoId } }))
                    window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId: file.videoId } }))
                    window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: file.videoId, videoVersion: null } }))
                  }, 0)
                }}
                onDownloadFiles={handleDownloadFiles}
                sharedDownloadProgress={transferSummaryCombined}
                isSharedDownloadActive={hasAnyActiveTransfers}
                requestedOpenFolderName={requestedFilesFolderName}
                requestedOpenFileKey={requestedFilesFileKey}
                onOpenFileKeyHandled={() => setRequestedFilesFileKey(null)}
                onOpenFolderNameChange={handleFilesFolderChange}
                folderPreviewByName={folderPreviewByName}
                resolveFilePreviewUrl={resolveDownloadablePreviewUrl}
                resolveFilePlaybackUrl={resolveDownloadablePlaybackUrl}
                onPreviewTokenExpired={() => requestFilesRefresh(true)}
                onApproveVideo={handleApproveVideo}
                shareSlug={String(project.slug)}
                shareToken={null}
                transferItems={transferItemsCombined}
                canUploadToProjects={true}
                canDeleteUploads={true}
                onCreateUploadFolder={handleCreateUploadFolder}
                onUploadFiles={handleUploadFiles}
                onDeleteUploadFile={handleDeleteUploadFile}
                onDeleteUploadFolder={handleDeleteUploadFolder}
                onRenameUploadFolder={handleRenameUploadFolder}
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
                      showTimeDisplayToggle={true}
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

  // Share the user's time-display preference so that CommentSectionView and
  // CommentInput stay in sync with the VideoPlayer toggle.
  const { timeDisplayMode } = useTimeDisplayMode(Boolean(project?.useFullTimecode))
  const effectiveUseFullTimecode = timeDisplayMode === 'timecode'

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
              showTimeDisplayToggle={true}
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
                voiceNoteDraft={management.voiceNoteDraft}
                onVoiceNoteSelect={management.onVoiceNoteSelect}
                onVoiceNoteClear={management.onVoiceNoteClear}
                allowFileUpload={true}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                selectedEndTimestamp={management.selectedEndTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                onClearRange={management.handleClearRange}
                showTimestampReset={management.shouldShowTimestampReset}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={effectiveUseFullTimecode}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={false}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipients={project.recipients || []}
                currentVideoRestricted={currentVideoRestricted}
                restrictionMessage={restrictionMessage}
                commentsDisabled={commentsDisabled}
                showShortcutsButton={isDesktop}
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
              comments={serverComments as any}
              clientName={clientDisplayName}
              clientEmail={project.recipients?.[0]?.email}
              isApproved={isApproved}
              restrictToLatestVersion={Boolean(project.restrictCommentsToLatestVersion)}
              useFullTimecode={effectiveUseFullTimecode}
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
              showShortcutsButton={isDesktop}
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
                voiceNoteDraft={management.voiceNoteDraft}
                onVoiceNoteSelect={management.onVoiceNoteSelect}
                onVoiceNoteClear={management.onVoiceNoteClear}
                allowFileUpload={true}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                selectedEndTimestamp={management.selectedEndTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                onClearRange={management.handleClearRange}
                showTimestampReset={management.shouldShowTimestampReset}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={effectiveUseFullTimecode}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={false}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipients={project.recipients || []}
                currentVideoRestricted={currentVideoRestricted}
                restrictionMessage={restrictionMessage}
                commentsDisabled={commentsDisabled}
                showShortcutsButton={isDesktop}
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
