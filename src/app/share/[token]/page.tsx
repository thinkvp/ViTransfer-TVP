'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import VideoPlayer from '@/components/VideoPlayer'

export const dynamic = 'force-dynamic'
import CommentInput from '@/components/CommentInput'
import { CommentSectionView } from '@/components/CommentSection'
import VideoSidebar from '@/components/VideoSidebar'
import { ShareFilesBrowser } from '../../../components/ShareFilesBrowser'
import { ShareProjectSwitcher, type ShareProjectOption } from '@/components/ShareProjectSwitcher'
import { ShareAlbumViewer } from '@/components/ShareAlbumViewer'
import { ProjectActivityPanel } from '@/components/ProjectActivityPanel'
import { useResizableSidePanel } from '@/hooks/useResizableSidePanel'
import { OTPInput } from '@/components/OTPInput'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Lock, Check, Mail, KeyRound } from 'lucide-react'
import { loadShareToken, saveShareToken } from '@/lib/share-token-store'
import { apiFetch, attemptRefresh } from '@/lib/api-client'
import { getAccessToken } from '@/lib/token-store'
import { openProjectEventStream, type ProjectEventType } from '@/lib/project-event-stream'
import { isS3Mode } from '@/lib/storage-provider-client'
import { extractUploadMediaMetadata } from '@/lib/upload-media-metadata-client'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { useSubtitleEditor } from '@/hooks/useSubtitleEditor'
import { SubtitleEditPanel } from '@/components/subtitle-editor/SubtitleEditPanel'
import { SubtitleTimelineStrip } from '@/components/subtitle-editor/SubtitleTimelineStrip'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'
import { useTimeDisplayMode } from '@/hooks/useTimeDisplayMode'
import { useContentImageRefresh } from '@/hooks/useContentImageRefresh'
import { cn } from '@/lib/utils'
import type { DownloadableFile, DownloadableGroup } from '@/lib/downloadable-files'
import { getDownloadableFileKey, getDownloadableFileKind } from '@/lib/downloadable-file-utils'
import type { DownloadQueueItem } from '@/lib/download-queue'
import { useDownloadTransfers } from '@/hooks/useDownloadTransfers'
import { calculateTransferSummary, createTransferId, isTransferActive, type TransferItem } from '@/lib/transfer-state'

type SwitchableProject = {
  id: string
  slug: string
  title: string
  status: string
  updatedAt: string
}

type DraftNavigationGuard = {
  confirmDiscardDraft: () => boolean
}

type UploadAccessUrlCacheEntry = {
  downloadUrl: string | null
  playbackUrl: string | null
  previewUrl: string | null
  previewStatus: string | null
  expiresAt: number
}

// One video-token batch item's result (from POST /api/share/[token]/video-token/batch).
type VideoTokenResult = {
  token: string
  streamUrl: string
  hlsUrl: string
  hlsAbr: boolean
}

const EMPTY_VIDEO_TOKEN_RESULT: VideoTokenResult = { token: '', streamUrl: '', hlsUrl: '', hlsAbr: false }

const UNSENT_COMMENT_MESSAGE = 'You have an unsent comment. Are you sure you want to leave?'
const UPLOAD_ACCESS_URL_CACHE_TTL_MS = 45 * 1000

export default function SharePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = params?.token as string

  // Parse URL parameters for video seeking
  const urlTimestamp = searchParams?.get('t') ? parseInt(searchParams.get('t')!, 10) : null
  const urlVideoName = searchParams?.get('video') || null
  const urlVersion = searchParams?.get('version') ? parseInt(searchParams.get('version')!, 10) : null

  const [isPasswordProtected, setIsPasswordProtected] = useState<boolean | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authMode, setAuthMode] = useState<string>('PASSWORD')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [showOtpHint, setShowOtpHint] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [project, setProject] = useState<any>(null)
  const [comments, setComments] = useState<any[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p'>('720p')
  const [hasLogo, setHasLogo] = useState(false)
  const [mainCompanyDomain, setMainCompanyDomain] = useState<string | null>(null)
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [allVideosByName, setAllVideosByName] = useState<Record<string, any[]>>({})
  const [tokensLoading, setTokensLoading] = useState(false)
  const [albums, setAlbums] = useState<any[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(false)
  const [downloadableFiles, setDownloadableFiles] = useState<DownloadableGroup[] | null>(null)
  const [hasApprovableVideos, setHasApprovableVideos] = useState(false)
  const [desktopContentTab, setDesktopContentTab] = useState<'view' | 'files'>('files')
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null)
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [isAdminSession, setIsAdminSession] = useState(false)
  // Client name capture: 'checking' until we know whether a name is already
  // stored/derivable for the current project, then 'needed' (show the blocking modal)
  // or 'done'. Re-evaluated per project so it stays correct across project switches.
  const [nameCaptureState, setNameCaptureState] = useState<'checking' | 'needed' | 'done'>('checking')
  // Adjustable width for the Project Activity panel, shared with the Comment Display width.
  const activityPanelResize = useResizableSidePanel()
  const [switchableProjects, setSwitchableProjects] = useState<SwitchableProject[]>([])
  const [switchProjectsLoading, setSwitchProjectsLoading] = useState(false)
  const [switchProjectsError, setSwitchProjectsError] = useState<string | null>(null)
  const [switchingProjectId, setSwitchingProjectId] = useState<string | null>(null)
  const [headerVersionId, setHeaderVersionId] = useState<string | null>(null)
  const [requestedFilesFolderName, setRequestedFilesFolderName] = useState<string | null>(null)
  const [requestedFilesFileKey, setRequestedFilesFileKey] = useState<string | null>(null)
  const [uploadTransferItems, setUploadTransferItems] = useState<TransferItem[]>([])
  const [uploadTransferPanelVersion, setUploadTransferPanelVersion] = useState(0)
  const draftGuardRef = useRef<DraftNavigationGuard | null>(null)
  // Set to the subtitle editor's discard-guard while editing (see effect below),
  // so sidebar/album/uploads navigation also prompts on unsaved subtitle edits.
  const subtitleGuardRef = useRef<(() => boolean) | null>(null)
  const uploadAbortControllersRef = useRef<Map<string, AbortController>>(new Map())
  const uploadCancelRequestedRef = useRef(false)
  const lastFilesRefreshAtRef = useRef(0)
  const filesRefreshInFlightRef = useRef(false)
  const storageKey = token || ''
  const tokenCacheRef = useRef<Map<string, any>>(new Map())
  const tokenRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const sidebarVideoCacheRef = useRef<Map<string, any>>(new Map())
  const sidebarThumbnailRequestCacheRef = useRef<Map<string, Promise<any>>>(new Map())
  const lastVideoTokenRefreshAtRef = useRef(0)
  // Rate-limit backoff for the video-token endpoint: when a fetch gets 429'd we
  // stop issuing token requests until this timestamp. Without it, empty tokens
  // break playback → the error handler forces a full re-mint → more 429s → a
  // self-sustaining flood that trips the server-side lockout (seen in prod).
  const videoTokenBackoffUntilRef = useRef(0)
  // Set on every full project refetch; lets the SSE handler skip the echo of an
  // action this page itself just performed (approve → local refetch → own
  // `approval` event ~0.5s later would otherwise refetch everything again).
  const lastProjectDataFetchAtRef = useRef(0)
  // Throttle for error-driven forced token refreshes (video element errors).
  const lastStreamErrorRefreshAtRef = useRef(0)
  const uploadAccessUrlCacheRef = useRef<Map<string, UploadAccessUrlCacheEntry>>(new Map())
  const uploadAccessUrlRequestCacheRef = useRef<Map<string, Promise<UploadAccessUrlCacheEntry | null>>>(new Map())
  // Pending upload-access requests coalesced into a single batch POST. Keyed by cacheKey;
  // each entry carries the fileId to request and the resolver for its in-flight promise.
  const uploadAccessBatchRef = useRef<Map<string, { fileId: string; resolve: (value: UploadAccessUrlCacheEntry | null) => void }>>(new Map())
  const uploadAccessBatchTimerRef = useRef<number | null>(null)
  // Pending video-token requests coalesced into a single batch POST (same pattern as the
  // upload-access batch above). Keyed by `${videoId}:${quality}`; a full tokenization pass
  // used to fire 4-6 single GETs per video *version* (~100+ on a large project), which is
  // what kept tripping the per-IP share-video-token rate limit for legitimate viewers.
  const videoTokenBatchRef = useRef<Map<string, { videoId: string; quality: string; resolvers: Array<(value: VideoTokenResult) => void> }>>(new Map())
  const videoTokenBatchTimerRef = useRef<number | null>(null)
  // Single source of truth for the live share token, readable synchronously by async
  // fetchers/retries without capturing a stale value in their closures. Kept in sync
  // with the `shareToken` state below.
  const shareTokenRef = useRef<string | null>(null)
  // Coalesces concurrent session-recovery probes (a video switch fires a burst of token
  // requests that can all 401 at once) into a single revalidation.
  const sessionRecoveryInFlightRef = useRef<Promise<boolean> | null>(null)
  const logoSrc = '/api/branding/logo'

  // Centralised session-expiry handler — clears all caches and resets auth state.
  // Call this whenever a 401 is received or when the JWT expiry timer fires.
  const clearAllShareCaches = useCallback(() => {
    tokenCacheRef.current.clear()
    tokenRequestCacheRef.current.clear()
    sidebarVideoCacheRef.current.clear()
    sidebarThumbnailRequestCacheRef.current.clear()
    uploadAccessUrlCacheRef.current.clear()
    uploadAccessUrlRequestCacheRef.current.clear()
    if (uploadAccessBatchTimerRef.current != null) {
      window.clearTimeout(uploadAccessBatchTimerRef.current)
      uploadAccessBatchTimerRef.current = null
    }
    uploadAccessBatchRef.current.forEach((item) => item.resolve(null))
    uploadAccessBatchRef.current.clear()
    lastFilesRefreshAtRef.current = 0
    filesRefreshInFlightRef.current = false
    lastVideoTokenRefreshAtRef.current = 0
  }, [])

  // Keep the synchronous token ref aligned with React state.
  useEffect(() => {
    shareTokenRef.current = shareToken
  }, [shareToken])

  // Adopt a share token everywhere at once (ref + state + storage) so async readers
  // never see a torn value.
  const adoptShareToken = useCallback((value: string | null) => {
    shareTokenRef.current = value
    setShareToken(value)
    saveShareToken(storageKey, value)
  }, [storageKey])

  // Re-validate the session with the freshest persisted token before tearing it down.
  // A burst of concurrent 401s (token mid-rotation, stale closures) collapses to ONE
  // probe; if the session is actually healthy we adopt the renewed token and keep going.
  const revalidateShareSession = useCallback(async (): Promise<boolean> => {
    if (isAdminSession) return false
    if (sessionRecoveryInFlightRef.current) return sessionRecoveryInFlightRef.current

    const attempt = (async (): Promise<boolean> => {
      const persisted = loadShareToken(storageKey) || shareTokenRef.current
      if (!persisted) return false
      try {
        const res = await apiFetch(`/api/share/${token}`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${persisted}` },
        })
        if (!res.ok) return false
        const data = await res.json().catch(() => null)
        const renewed = (data && typeof data === 'object' && typeof (data as any).shareToken === 'string' && (data as any).shareToken)
          ? (data as any).shareToken
          : persisted
        adoptShareToken(renewed)
        return true
      } catch {
        return false
      }
    })()

    sessionRecoveryInFlightRef.current = attempt
    try {
      return await attempt
    } finally {
      sessionRecoveryInFlightRef.current = null
    }
  }, [isAdminSession, storageKey, token, adoptShareToken])

  const handleSessionExpired = useCallback(async (response?: Response) => {
    // Don't nuke a healthy session on a single transient 401 — confirm it's really dead
    // first. If revalidation succeeds, the renewed token has already been adopted.
    if (!isAdminSession) {
      const recovered = await revalidateShareSession()
      if (recovered) return
    }
    clearAllShareCaches()
    adoptShareToken(null)
    setDownloadableFiles(null)
    setAlbums([])
    setSwitchableProjects([])
    setSwitchProjectsError(null)
    setIsPasswordProtected(true)
    setIsAuthenticated(false)
    if (response) {
      try {
        const data = await response.json().catch(() => null)
        setAuthMode((data && typeof data === 'object' && 'authMode' in data) ? String((data as any).authMode || 'PASSWORD') : 'PASSWORD')
      } catch {
        setAuthMode('PASSWORD')
      }
    } else {
      setAuthMode('PASSWORD')
    }
  }, [clearAllShareCaches, adoptShareToken, isAdminSession, revalidateShareSession])

  const isUploadsFilesBrowse = desktopContentTab === 'files'
    && String(requestedFilesFolderName || '').trim().startsWith('UPLOADS')
  const uploadsHeaderPath = isUploadsFilesBrowse ? String(requestedFilesFolderName || '').trim() : ''
  // Display-only: the internal group-name protocol still uses the 'UPLOADS' prefix
  // (matched elsewhere via startsWith('UPLOADS')), but clients see "Additional Files".
  const uploadsHeaderPathDisplay = uploadsHeaderPath.replace(/^UPLOADS\b/, 'Additional Files')

  const otpEmailStorageKey = token ? `share-otp-email:${token}` : null

  const otpSessionEmail = (() => {
    if (typeof window === 'undefined') return null
    if (!otpEmailStorageKey) return null
    try {
      const stored = sessionStorage.getItem(otpEmailStorageKey)
      return stored && typeof stored === 'string' ? stored : null
    } catch {
      return null
    }
  })()

  const confirmShareDraftNavigation = useCallback(() => {
    const guard = draftGuardRef.current
    if (guard && !guard.confirmDiscardDraft()) return false
    // Also honor unsaved subtitle edits (sidebar/album/uploads switches bypass
    // the player's own video-switch guard).
    const subGuard = subtitleGuardRef.current
    if (subGuard && !subGuard()) return false
    return true
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

  // Show hint 15s after OTP is sent in case user didn't receive a code
  useEffect(() => {
    if (!otpSent) {
      setShowOtpHint(false)
      return
    }
    const timer = setTimeout(() => setShowOtpHint(true), 15000)
    return () => clearTimeout(timer)
  }, [otpSent])

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

  // Detect admin session (JWT) so we don't accidentally use a cached guest share token.
  useEffect(() => {
    let isMounted = true

    async function checkAdminSession() {
      try {
        const res = await apiFetch('/api/auth/session', { cache: 'no-store' })
        if (!isMounted) return
        setIsAdminSession(res.ok)
      } catch {
        if (!isMounted) return
        setIsAdminSession(false)
      }
    }

    void checkAdminSession()
    return () => {
      isMounted = false
    }
  }, [])

  // Fetch branding info on mount (before auth) so logo is available on the auth screen
  useEffect(() => {
    let isMounted = true
    async function fetchBranding() {
      try {
        const res = await apiFetch('/api/branding/info', { cache: 'no-store' })
        if (!isMounted) return
        if (res.ok) {
          const data = await res.json()
          setHasLogo(data.hasLogo || false)
          setMainCompanyDomain(data.mainCompanyDomain || null)
        }
      } catch {
        // ignore – branding is optional
      }
    }
    void fetchBranding()
    return () => { isMounted = false }
  }, [])

  // Load stored token once (persist across refresh) - only for non-admin viewers.
  useEffect(() => {
    if (!storageKey) return
    if (isAdminSession) return
    const stored = loadShareToken(storageKey)
    if (stored) {
      setShareToken(stored)
    }
  }, [storageKey, isAdminSession])

  // Fetch comments separately for security
  const fetchComments = useCallback(async (tokenOverride?: string | null) => {
    const authToken = tokenOverride || shareTokenRef.current
    if (!token) return
    if (!isAdminSession && !authToken) return

    setCommentsLoading(true)
    try {
      const response = await apiFetch(`/api/share/${token}/comments`, {
        cache: 'no-store',
        headers: !isAdminSession && authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      })
      if (response.status === 401 && !isAdminSession) {
        await handleSessionExpired(response)
        return
      }
      if (response.ok) {
        const commentsData = await response.json()
        setComments(commentsData)
      }
    } catch (error) {
      // Failed to load comments
    } finally {
      setCommentsLoading(false)
    }
  }, [token, isAdminSession, handleSessionExpired])

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

  // Keep recipients in sync when a client adds/deletes a custom name.
  // This avoids losing the newly-added option when switching videos (CommentInput can remount).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as any
      if (!detail) return

      if (detail.action === 'add' && detail.recipient?.id) {
        const id = String(detail.recipient.id)
        const name = String(detail.recipient.name || '').trim()
        if (!id || !name) return

        setProject((prev: any) => {
          if (!prev) return prev
          const prevRecipients = Array.isArray(prev.recipients) ? prev.recipients : []
          if (prevRecipients.some((r: any) => String(r?.id || '') === id)) return prev
          return {
            ...prev,
            recipients: [...prevRecipients, { id, name, email: null }],
          }
        })

        return
      }

      if (detail.action === 'delete' && detail.recipientId) {
        const recipientId = String(detail.recipientId)
        if (!recipientId) return

        setProject((prev: any) => {
          if (!prev) return prev
          const prevRecipients = Array.isArray(prev.recipients) ? prev.recipients : []
          return {
            ...prev,
            recipients: prevRecipients.filter((r: any) => String(r?.id || '') !== recipientId),
          }
        })
      }
    }

    window.addEventListener('shareRecipientsChanged', handler)
    return () => window.removeEventListener('shareRecipientsChanged', handler)
  }, [])

  // Fetch project data function (for refresh after approval)
  const fetchProjectData = useCallback(async (tokenOverride?: string | null) => {
    // Stamped up-front so the SSE handler can recognise (and skip) the echo of
    // an action this page itself just performed.
    lastProjectDataFetchAtRef.current = Date.now()
    try {
      const authToken = tokenOverride || shareToken
      const projectResponse = await apiFetch(`/api/share/${token}`, {
        cache: 'no-store',
        headers: !isAdminSession && authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      })

      if (projectResponse.status === 401 && !isAdminSession) {
        await handleSessionExpired(projectResponse)
        return
      }

      if (projectResponse.ok) {
        const projectData = await projectResponse.json()

        if (projectData.shareToken) {
          setShareToken(projectData.shareToken)
          saveShareToken(storageKey, projectData.shareToken)
        } else if (tokenOverride) {
          setShareToken(tokenOverride)
          saveShareToken(storageKey, tokenOverride)
        }
        setProject(projectData)

        // Invalidate video-token caches ONLY for videos whose approval state
        // changed (approval flips the viewer's entitlements, e.g. unlocks the
        // original download) or that no longer exist. The previous blanket clear
        // made every project refetch re-mint tokens for EVERY video version
        // (4-6 requests each) — doubled by the SSE echo of the viewer's own
        // approval, that blew through the video-token rate limit on larger
        // projects and locked the client out. The preload effect skips cached
        // entries, so unchanged videos now cost zero token requests.
        const freshVideos: any[] = Array.isArray(projectData.videos) ? projectData.videos : []
        const freshById = new Map(freshVideos.map((v: any) => [String(v.id), v]))
        for (const [videoId, cached] of Array.from(tokenCacheRef.current.entries())) {
          const fresh = freshById.get(String(videoId))
          if (!fresh || Boolean(cached?.approved) !== Boolean((fresh as any).approved)) {
            tokenCacheRef.current.delete(videoId)
            sidebarVideoCacheRef.current.delete(videoId)
            sidebarThumbnailRequestCacheRef.current.delete(videoId)
          }
        }

        // Rebuild the tokenized sidebar state on the fresh payload's group
        // structure (correct for renames/deletes/new versions), reusing the
        // tokenized copies of videos whose entitlements didn't change. Videos
        // invalidated above fall back to the raw payload object and get
        // re-tokenized by the preload effect.
        setAllVideosByName((prev) => {
          if (Object.keys(prev).length === 0) return prev
          const tokenizedById = new Map<string, any>()
          for (const versions of Object.values(prev)) {
            for (const v of versions as any[]) tokenizedById.set(String(v.id), v)
          }
          const next: Record<string, any[]> = {}
          for (const [name, versions] of Object.entries(projectData.videosByName || {})) {
            next[name] = (versions as any[]).map((v: any) => {
              const tokenized = tokenizedById.get(String(v.id))
              // Reuse the tokenized copy, but carry over fields that change without
              // flipping approval (which is what invalidates the token cache) — the
              // "Reviewed" state must reflect live for other viewers of this page.
              return tokenized && tokenCacheRef.current.has(String(v.id))
                ? { ...tokenized, revisionRequestedAt: (v as any).revisionRequestedAt ?? null }
                : v
            })
          }
          return next
        })

        // Fetch comments after project loads (if not hidden)
        if (!projectData.hideFeedback) {
          fetchComments(projectData.shareToken || tokenOverride)
        }
      }
    } catch (error) {
      // Failed to load project data
    }
  }, [fetchComments, shareToken, storageKey, token, isAdminSession, handleSessionExpired])

  const fetchAlbums = useCallback(async (tokenOverride?: string | null) => {
    const authToken = tokenOverride || shareToken
    if (!token) return

    if (project?.enablePhotos === false) {
      setAlbums([])
      return
    }

    setAlbumsLoading(true)
    try {
      const response = await apiFetch(`/api/share/${token}/albums`, {
        cache: 'no-store',
        headers: !isAdminSession && authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      })
      if (response.status === 401 && !isAdminSession) {
        await handleSessionExpired(response)
        return
      }
      if (response.ok) {
        const data = await response.json()
        const albumsRaw = Array.isArray(data?.albums) ? data.albums : []
        const albumsSorted = [...albumsRaw].sort((a: any, b: any) =>
          String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' })
        )
        setAlbums(albumsSorted)
      }
    } catch {
      // ignore
    } finally {
      setAlbumsLoading(false)
    }
  }, [token, shareToken, isAdminSession, project, handleSessionExpired])

  const fetchDownloadableFiles = useCallback(async (tokenOverride?: string | null) => {
    const authToken = tokenOverride || shareToken
    if (!isAdminSession && !authToken) return
    try {
      const res = await apiFetch(`/api/share/${token}/downloadable-files`, {
        headers: !isAdminSession && authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      })
      if (res.ok) {
        const data = await res.json()
        setDownloadableFiles(Array.isArray(data.groups) ? data.groups : [])
        setHasApprovableVideos(!!data.hasApprovableVideos)
      }
    } catch {
      // ignore
    }
  }, [token, shareToken, isAdminSession])

  // Live project updates: subscribe to the project's SSE stream so activity by
  // anyone (a client's comment, an approval, a status change, a newly-processed
  // video version) appears for everyone without a manual refresh. The stream
  // only signals the change TYPE; we refetch through the authenticated
  // endpoints. Refetches are debounced per-type to coalesce bursts, and we also
  // refetch when the tab regains visibility as a safety net for dropped links.
  useEffect(() => {
    if (!token) return
    // Resolved per (re)connect attempt so reconnects pick up rotated tokens —
    // admin access tokens refresh every ~15 min, and a captured string would
    // leave every reconnect after that sending an expired credential.
    const getStreamAuthToken = () => (
      isAdminSession ? getAccessToken() : (loadShareToken(storageKey) || shareTokenRef.current)
    )
    // Non-admins need a share token to read the project; without one there's nothing to stream.
    if (!isAdminSession && !getStreamAuthToken()) return

    const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {}
    const debounce = (key: string, fn: () => void) => {
      if (timers[key]) clearTimeout(timers[key])
      timers[key] = setTimeout(fn, 200)
    }
    const refetchComments = () => debounce('comments', () => { void fetchComments() })
    const refetchProject = () => debounce('project', () => {
      // Skip the echo of an action this page performed itself: e.g. approving a
      // video refetches locally AND publishes an `approval` event that arrives
      // back here ~0.5s later — without this guard the page paid for two full
      // refetch passes per approval. A concurrent remote change inside this tiny
      // window is caught by the focus/visibility refresh safety nets.
      if (Date.now() - lastProjectDataFetchAtRef.current < 2_500) return
      void fetchProjectData()
      // Approval also changes original-quality download availability, so keep the
      // Files browser in sync too (matches the local approve handler).
      void fetchDownloadableFiles()
    })

    const handleEvent = (type: ProjectEventType) => {
      // The Project Activity feed aggregates every event kind — nudge it to refresh
      // on anything (the panel listens for this and refetches, throttled).
      if (type !== 'internal') {
        window.dispatchEvent(new CustomEvent('projectActivityRefresh'))
      }
      switch (type) {
        case 'comment':
          refetchComments()
          break
        case 'approval':
        case 'status':
        case 'video':
          // Approval badges, status, and video versions all live in project data.
          refetchProject()
          break
        case 'upload':
          // A file/folder was added, removed, or renamed in the Uploads area.
          debounce('files', () => { void fetchDownloadableFiles() })
          break
        case 'album':
          // An album or photo was added/removed/renamed.
          debounce('albums', () => { void fetchAlbums(); void fetchDownloadableFiles() })
          break
        case 'internal':
          // Admin-only team chat — not shown on the share page; ignore.
          break
      }
    }

    const handle = openProjectEventStream({
      token,
      authToken: getStreamAuthToken,
      onEvent: handleEvent,
      onAuthError: () => {
        if (isAdminSession) {
          // Rotate the expired admin access token so the next retry succeeds.
          void attemptRefresh()
        } else {
          // Session likely expired; let the existing auth flow surface the re-auth UI.
          void fetchComments()
        }
      },
    })

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        refetchComments()
        refetchProject()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      Object.values(timers).forEach((t) => { if (t) clearTimeout(t) })
      document.removeEventListener('visibilitychange', onVisibility)
      handle.close()
    }
  }, [token, isAdminSession, shareToken, storageKey, fetchComments, fetchProjectData, fetchDownloadableFiles, fetchAlbums])

  const requestFilesRefresh = useCallback((force = false) => {
    if (desktopContentTab !== 'files') return
    if (filesRefreshInFlightRef.current) return

    const now = Date.now()
    if (!force && now - lastFilesRefreshAtRef.current < 45_000) return

    filesRefreshInFlightRef.current = true
    lastFilesRefreshAtRef.current = now

    const authToken = !isAdminSession ? (loadShareToken(storageKey) || shareToken) : null
    void fetchDownloadableFiles(authToken || shareToken)
      .finally(() => {
        filesRefreshInFlightRef.current = false
      })
  }, [desktopContentTab, fetchDownloadableFiles, isAdminSession, shareToken, storageKey])

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

  const fetchSwitchableProjects = useCallback(async (tokenOverride?: string | null) => {
    const authToken = tokenOverride || shareToken

    if (!token || !project?.id || isAdminSession) {
      setSwitchableProjects([])
      setSwitchProjectsError(null)
      return
    }

    if (!authToken) {
      setSwitchableProjects([])
      return
    }

    setSwitchProjectsLoading(true)
    setSwitchProjectsError(null)
    try {
      const response = await apiFetch(`/api/share/${token}/projects`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${authToken}` },
      })

      if (response.status === 401) {
        await handleSessionExpired(response)
        setSwitchableProjects([])
        return
      }

      if (response.status === 403) {
        setSwitchableProjects([])
        return
      }

      if (!response.ok) {
        setSwitchProjectsError('Unable to load other client projects right now.')
        setSwitchableProjects([])
        return
      }

      const data = await response.json()
      setSwitchableProjects(Array.isArray(data?.projects) ? data.projects : [])
    } catch {
      setSwitchProjectsError('Unable to load other client projects right now.')
      setSwitchableProjects([])
    } finally {
      setSwitchProjectsLoading(false)
    }
  }, [token, shareToken, project?.id, isAdminSession, handleSessionExpired])

  const handleProjectSwitch = useCallback(async (targetProject: SwitchableProject) => {
    if (!shareToken || !token) return
    if (!confirmShareDraftNavigation()) return

    setSwitchingProjectId(targetProject.id)
    setSwitchProjectsError(null)
    try {
      const response = await apiFetch(`/api/share/${token}/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shareToken}`,
        },
        body: JSON.stringify({ projectId: targetProject.id }),
      })

      if (response.status === 401) {
        await handleSessionExpired(response)
        return
      }

      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.shareToken || !data?.project?.slug) {
        setSwitchProjectsError((data && typeof data?.error === 'string') ? data.error : 'Unable to switch projects right now.')
        return
      }

      saveShareToken(data.project.slug, data.shareToken)

      const targetOtpStorageKey = `share-otp-email:${data.project.slug}`
      try {
        if (data.accessMethod === 'OTP' && typeof data.email === 'string' && data.email.trim()) {
          sessionStorage.setItem(targetOtpStorageKey, data.email.trim().toLowerCase())
        } else {
          sessionStorage.removeItem(targetOtpStorageKey)
        }
      } catch {
        // ignore session storage failures
      }

      router.push(`/share/${data.project.slug}`)
    } catch {
      setSwitchProjectsError('Unable to switch projects right now.')
    } finally {
      setSwitchingProjectId(null)
    }
  }, [confirmShareDraftNavigation, router, shareToken, token, handleSessionExpired])

  // When a client approves a video from the comment panel, refresh project/videos so UI updates without a full reload.
  useEffect(() => {
    const handleApprovalChanged = (e: Event) => {
      const videoId = (e as CustomEvent).detail?.videoId
      if (videoId) {
        markVideoApproved(videoId)
      }
      // Use the latest persisted token; fall back to current in-memory token.
      const persisted = loadShareToken(storageKey)
      fetchProjectData(persisted || shareToken)
      void fetchDownloadableFiles(persisted || shareToken)
    }

    window.addEventListener('videoApprovalChanged', handleApprovalChanged)
    return () => {
      window.removeEventListener('videoApprovalChanged', handleApprovalChanged)
    }
    // Intentionally omit fetchProjectData from deps; it's stable enough for this usage and avoids re-binding.
  }, [fetchProjectData, fetchDownloadableFiles, markVideoApproved, shareToken, storageKey])

  // Company name and default quality now loaded from project settings
  // This ensures they're only accessible after authentication

  // Load project data (handles auth check implicitly via API response)
  useEffect(() => {
    let isMounted = true

    async function loadProject() {
      try {
        setLoadError(null)

        // Read the freshest persisted token synchronously rather than depending on the
        // `shareToken` state. The base route mints a new token on every call, so depending
        // on state here created a self-feeding refetch loop (load → setShareToken → reload)
        // that churned the token and opened the 401 race window when switching videos.
        const authToken = !isAdminSession ? (loadShareToken(storageKey) || shareTokenRef.current) : null
        const response = await apiFetch(`/api/share/${token}`, {
          cache: 'no-store',
          headers: !isAdminSession && authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        })

        if (!isMounted) return

        if (response.status === 401) {
          await handleSessionExpired(response)
          return
        }

        if (response.status === 403) {
          const data = await response.json().catch(() => null)
          const message = (data && typeof data === 'object' && 'error' in data) ? String((data as any).error || '') : ''
          if (message.toLowerCase().includes('closed')) {
            // Treat closed share links like not-found for external users.
            setError('')
            setIsAuthenticated(false)
            setIsPasswordProtected(false)
            setProject(null)
            return
          }
        }

        if (response.status === 403 || response.status === 404) {
          setIsAuthenticated(false)
          setIsPasswordProtected(false)
          setProject(null)
          return
        }

        if (response.ok) {
          const projectData = await response.json()
          if (projectData.shareToken) {
            adoptShareToken(projectData.shareToken)
          }
          if (isMounted) {
            setProject(projectData)
            setIsPasswordProtected(!!projectData.recipients && projectData.recipients.length > 0)
            setIsAuthenticated(true)

            if (projectData.settings) {
              setCompanyName(projectData.settings.companyName || 'Studio')
              setDefaultQuality(projectData.settings.defaultPreviewResolution || '720p')
              setHasLogo(projectData.settings.hasLogo || false)
              setMainCompanyDomain(projectData.settings.mainCompanyDomain || null)
            }

            if (!projectData.hideFeedback) {
              fetchComments(projectData.shareToken)
            }
          }
        } else {
          // Unhandled status (500, 503, 429, etc.) — surface an error instead of
          // leaving isPasswordProtected as null, which would show "Loading..." forever.
          setIsPasswordProtected(false)
          setIsAuthenticated(false)
          setProject(null)
          setLoadError('Unable to load this page right now. The server may be busy — please try again.')
        }
      } catch (error) {
        if (!isMounted) return
        setIsAuthenticated(false)
        setIsPasswordProtected(false)
        setProject(null)
        setLoadError('Unable to connect. Please check your connection and try again.')
      }
    }

    loadProject()

    return () => {
      isMounted = false
    }
    // NOTE: `shareToken` is intentionally NOT a dependency. loadProject reads the freshest
    // persisted token at call time; depending on the state value re-ran this effect on every
    // token rotation, which is the refetch loop we removed.
  }, [token, storageKey, fetchComments, isAdminSession, handleSessionExpired, adoptShareToken])

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    if (activeAlbumId) return
    if (project?.enableVideos === false) return
    if (project?.videosByName) {
      // Sort video names: prioritize the sidebar "For Review" group (no approved versions),
      // then "Reviewed" (latest version has the next version requested), then "Approved",
      // then alphabetically. Keep this in sync with the grouping logic in VideoSidebar.
      const names = Object.keys(project.videosByName)
      const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })
      const isApprovedGroup = (videoName: string) => (project.videosByName[videoName] || []).some((v: any) => v?.approved === true)
      const isReviewedGroup = (videoName: string) => {
        if (isApprovedGroup(videoName)) return false
        const groupVideos = project.videosByName[videoName] || []
        const latest = [...groupVideos].sort((a: any, b: any) => ((b as any)?.version ?? 0) - ((a as any)?.version ?? 0))[0]
        return Boolean((latest as any)?.revisionRequestedAt)
      }

      const forReview = names.filter((n) => !isApprovedGroup(n) && !isReviewedGroup(n)).sort(byName)
      const reviewed = names.filter((n) => isReviewedGroup(n)).sort(byName)
      const approved = names.filter((n) => isApprovedGroup(n)).sort(byName)
      const videoNames = [...forReview, ...reviewed, ...approved]
      if (videoNames.length === 0) return

      // Determine which video should be active
      if (!activeVideoName) {
        let videoNameToUse: string | null = null
        let shouldOpenPlayer = false

        // Priority 1: URL parameter for video name → deep link, open the player.
        if (urlVideoName && project.videosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
          shouldOpenPlayer = true
        }
        // Priority 2: Saved video name from recent approval
        else {
          const savedVideoName = sessionStorage.getItem('approvedVideoName')
          if (savedVideoName) {
            sessionStorage.removeItem('approvedVideoName')
            if (project.videosByName[savedVideoName]) {
              videoNameToUse = savedVideoName
            }
          }
        }

        // Nothing to auto-select — leave the sidebar unselected (Files at root).
        if (!videoNameToUse) return

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        setActiveVideosRaw(videos)

        // Keep the sidebar highlight and Files browser folder in sync.
        if (!shouldOpenPlayer) {
          setRequestedFilesFolderName(videoNameToUse)
        }

        // If URL specifies a version, calculate the index for initial selection
        if (urlVersion !== null && videos) {
          const targetIndex = videos.findIndex((v: any) => v.version === urlVersion)
          if (targetIndex !== -1) {
            setInitialVideoIndex(targetIndex)
          }
        }

        // Set initial seek time if URL parameter exists
        if (urlTimestamp !== null) {
          setInitialSeekTime(urlTimestamp)
        }

        if (shouldOpenPlayer) {
          setDesktopContentTab('view')
        }
      } else {
        // Keep activeVideos in sync when project data refreshes (ensures updated approval status/thumbnails/tokens)
        const videos = project.videosByName[activeVideoName]
        if (videos) {
          setActiveVideosRaw(videos)
        }
      }
    }
  }, [project?.videosByName, project?.enableVideos, activeVideoName, urlVideoName, urlVersion, urlTimestamp, activeAlbumId])

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

  // Record a video-token rate-limit response: honour Retry-After (clamped to a
  // sane range) so every token consumer stops hitting the endpoint until the
  // window resets, instead of feeding the 429 → broken playback → forced
  // re-mint → 429 loop.
  const noteVideoTokenRateLimited = useCallback((response: Response) => {
    const retryAfter = Number(response.headers.get('Retry-After'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter, 120) * 1000
      : 60_000
    videoTokenBackoffUntilRef.current = Math.max(
      videoTokenBackoffUntilRef.current,
      Date.now() + waitMs,
    )
  }, [])

  const isVideoTokenBackoffActive = useCallback(
    () => Date.now() < videoTokenBackoffUntilRef.current,
    [],
  )

  // Fire the queued video-token requests as one (chunked) batch POST and fan the results
  // back out to each waiting caller. Replaces the one-GET-per-(video, quality) pattern
  // that made a full tokenization pass cost ~100+ requests on a large project — the
  // per-IP rate limit then measured project size × concurrent viewers instead of abuse.
  const flushVideoTokenBatch = useCallback(async () => {
    videoTokenBatchTimerRef.current = null
    const pending = Array.from(videoTokenBatchRef.current.values())
    videoTokenBatchRef.current.clear()
    if (pending.length === 0) return

    const resolveEmpty = (items: typeof pending) => {
      for (const item of items) {
        for (const resolve of item.resolvers) resolve(EMPTY_VIDEO_TOKEN_RESULT)
      }
    }

    const authToken = shareTokenRef.current
    if (!authToken || isVideoTokenBackoffActive()) {
      resolveEmpty(pending)
      return
    }

    const CHUNK = 100
    const chunks: Array<typeof pending> = []
    for (let i = 0; i < pending.length; i += CHUNK) {
      chunks.push(pending.slice(i, i + CHUNK))
    }

    await Promise.all(chunks.map(async (chunk) => {
      try {
        const response = await fetch(`/api/share/${token}/video-token/batch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ items: chunk.map(({ videoId, quality }) => ({ videoId, quality })) }),
        })
        if (response.status === 401) {
          await handleSessionExpired(response)
          resolveEmpty(chunk)
          return
        }
        if (response.status === 429) {
          noteVideoTokenRateLimited(response)
          resolveEmpty(chunk)
          return
        }
        if (!response.ok) {
          resolveEmpty(chunk)
          return
        }
        const data = await response.json().catch(() => ({}))
        const results = (data && typeof (data as any).results === 'object' && (data as any).results)
          ? (data as any).results
          : {}
        for (const item of chunk) {
          const raw = results[`${item.videoId}:${item.quality}`]
          // A missing key means unavailable/unauthorized for this session (the batch
          // route's equivalent of the single GET's 403/404) — resolve empty.
          const value: VideoTokenResult = (raw && typeof raw === 'object') ? {
            token: typeof raw.token === 'string' ? raw.token : '',
            streamUrl: typeof raw.streamUrl === 'string' ? raw.streamUrl : '',
            // Per-video HLS master playlist (same value across quality fetches); '' when unavailable.
            hlsUrl: typeof raw.hlsUrl === 'string' ? raw.hlsUrl : '',
            hlsAbr: raw.hlsAbr === true,
          } : EMPTY_VIDEO_TOKEN_RESULT
          for (const resolve of item.resolvers) resolve(value)
        }
      } catch {
        resolveEmpty(chunk)
      }
    }))
  }, [token, handleSessionExpired, isVideoTokenBackoffActive, noteVideoTokenRateLimited])

  // Request one (videoId, quality) token via the coalescing batch. Also returns the
  // optional direct-to-R2 stream URL (Option B): in S3 mode the server hands back a
  // presigned URL the player can stream directly, bypassing the /api/content redirect;
  // `streamUrl` is '' for local mode / non-stream qualities, in which case callers fall
  // back to the token-gated /api/content URL.
  const fetchVideoStream = useCallback(async (
    videoId: string,
    quality: string,
  ): Promise<VideoTokenResult> => {
    if (!shareToken) return EMPTY_VIDEO_TOKEN_RESULT
    if (isVideoTokenBackoffActive()) return EMPTY_VIDEO_TOKEN_RESULT
    return new Promise<VideoTokenResult>((resolve) => {
      const key = `${videoId}:${quality}`
      const existing = videoTokenBatchRef.current.get(key)
      if (existing) {
        existing.resolvers.push(resolve)
      } else {
        videoTokenBatchRef.current.set(key, { videoId, quality, resolvers: [resolve] })
      }
      if (videoTokenBatchTimerRef.current == null) {
        // Short coalescing window: a tokenization pass enqueues all its pairs
        // synchronously-ish, so one flush catches the whole pass.
        videoTokenBatchTimerRef.current = window.setTimeout(() => {
          void flushVideoTokenBatch()
        }, 16)
      }
    })
  }, [shareToken, isVideoTokenBackoffActive, flushVideoTokenBatch])

  const fetchVideoToken = useCallback(async (videoId: string, quality: string) => {
    const result = await fetchVideoStream(videoId, quality)
    return result.token
  }, [fetchVideoStream])

  // Fire the queued upload-access requests as one (chunked) batch POST and fan the
  // results back out to each waiting caller. Replaces the previous one-POST-per-file
  // pattern that the visible-tile observer triggered for every file in a folder.
  const flushUploadAccessBatch = useCallback(async () => {
    uploadAccessBatchTimerRef.current = null
    const items = Array.from(uploadAccessBatchRef.current.entries()) // [cacheKey, { fileId, resolve }]
    uploadAccessBatchRef.current.clear()
    if (items.length === 0) return

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
        const url = `/api/share/${token}/uploads/download-tokens`
        const init: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(!isAdminSession && shareToken ? { Authorization: `Bearer ${shareToken}` } : {}),
          },
          body: JSON.stringify({ fileIds: chunkIds }),
        }
        const response = isAdminSession ? await apiFetch(url, init) : await fetch(url, init)
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

    for (const [cacheKey, item] of items) {
      uploadAccessUrlRequestCacheRef.current.delete(cacheKey)
      const raw = merged[item.fileId]
      if (!raw || typeof raw !== 'object') {
        // File missing from response (deleted / not found / chunk error) — don't cache.
        item.resolve(null)
        continue
      }
      const entry = buildEntry(raw)
      uploadAccessUrlCacheRef.current.set(cacheKey, entry)
      item.resolve(entry)
    }
  }, [isAdminSession, requestFilesRefresh, shareToken, token])

  const getUploadAccessUrl = useCallback(async (fileId: string): Promise<UploadAccessUrlCacheEntry | null> => {
    const normalizedFileId = String(fileId || '').trim()
    if (!normalizedFileId || normalizedFileId.startsWith('pending-')) return null

    const scopeKey = `${isAdminSession ? 'admin' : 'share'}:${shareToken || 'anon'}`
    const cacheKey = `${token}:${scopeKey}:${normalizedFileId}`
    const now = Date.now()

    const cached = uploadAccessUrlCacheRef.current.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached
    }

    const inFlight = uploadAccessUrlRequestCacheRef.current.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    // Queue this file for the next batch instead of firing its own request. A short
    // timer coalesces the burst of cache-miss calls the visible-tile observer makes.
    const request = new Promise<UploadAccessUrlCacheEntry | null>((resolve) => {
      uploadAccessBatchRef.current.set(cacheKey, { fileId: normalizedFileId, resolve })
    })
    uploadAccessUrlRequestCacheRef.current.set(cacheKey, request)

    if (uploadAccessBatchTimerRef.current == null) {
      uploadAccessBatchTimerRef.current = window.setTimeout(() => {
        void flushUploadAccessBatch()
      }, 16)
    }

    return request
  }, [flushUploadAccessBatch, isAdminSession, shareToken, token])

  useEffect(() => {
    uploadAccessUrlCacheRef.current.clear()
    uploadAccessUrlRequestCacheRef.current.clear()
    if (uploadAccessBatchTimerRef.current != null) {
      window.clearTimeout(uploadAccessBatchTimerRef.current)
      uploadAccessBatchTimerRef.current = null
    }
    uploadAccessBatchRef.current.forEach((item) => item.resolve(null))
    uploadAccessBatchRef.current.clear()
  }, [shareToken, isAdminSession, token])

  const resolveDownloadTarget = useCallback(async (file: DownloadableFile, signal?: AbortSignal): Promise<DownloadQueueItem | null> => {
    const authHeader: Record<string, string> = !isAdminSession && shareToken ? { Authorization: `Bearer ${shareToken}` } : {}
    try {
      let url: string
      if (file.type === 'video') {
        const r = await apiFetch(`/api/share/${token}/video-token?videoId=${file.videoId}&quality=original`, {
          signal,
          headers: authHeader,
        })
        const data = await r.json()
        url = `/api/content/${data.token}?download=true`
      } else if (file.type === 'asset') {
        const r = await apiFetch(`/api/videos/${file.videoId}/assets/${file.assetId}/download-token`, {
          method: 'POST',
          signal,
          headers: authHeader,
        })
        const data = await r.json()
        url = data.url
      } else if (file.type === 'album-zip') {
        const r = await apiFetch(`/api/share/${token}/albums/${file.albumId}/download-zip-token`, {
          method: 'POST',
          signal,
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: file.variant }),
        })
        const data = await r.json()
        url = data.url
      } else if (file.type === 'upload-file') {
        const tokenizedUrls = await getUploadAccessUrl(String(file.uploadFileId || ''))
        if (!tokenizedUrls?.downloadUrl) return null
        url = tokenizedUrls.downloadUrl
      } else {
        if (!file.downloadUrl) return null
        url = file.downloadUrl
      }
      if (!url || typeof url !== 'string') return null
      return { url, fileName: file.fileName }
    } catch {
      return null
    }
  }, [token, shareToken, isAdminSession, getUploadAccessUrl])

  const {
    transferItems,
    transferSummary: downloadTransferSummary,
    hasActiveTransfers: hasActiveDownloadTransfers,
    transferPanelVersion,
    downloadFile: handleDownloadFile,
    downloadFiles: handleDownloadFiles,
    cancelActiveTransfers,
    clearCompletedTransfers,
  } = useDownloadTransfers({
    projectTitle: project?.title,
    resolveDownloadTarget,
  })

  // Identity picked in the comment name picker (persisted by useCommentManagement).
  // Threaded into uploads/approvals so activity-feed attribution matches comments.
  const loadCommentIdentity = useCallback((): { authorName: string | null; recipientId: string | null } => {
    if (!project?.id || typeof window === 'undefined') return { authorName: null, recipientId: null }
    try {
      const stored = sessionStorage.getItem(`comment-name-${project.id}`)
      const parsed = stored ? JSON.parse(stored) : null
      return {
        authorName: typeof parsed?.authorName === 'string' && parsed.authorName.trim() ? parsed.authorName : null,
        recipientId: typeof parsed?.recipientId === 'string' && parsed.recipientId ? parsed.recipientId : null,
      }
    } catch {
      return { authorName: null, recipientId: null }
    }
  }, [project?.id])

  // Persist the chosen client identity in the same sessionStorage slot the comment
  // name picker (useCommentManagement) reads, so comments/uploads/approvals all agree.
  const persistCommentIdentity = useCallback((name: string, recipientId: string | null) => {
    if (!project?.id || typeof window === 'undefined') return
    try {
      sessionStorage.setItem(
        `comment-name-${project.id}`,
        JSON.stringify({ authorName: name, recipientId: recipientId || null }),
      )
    } catch {
      // sessionStorage unavailable — attribution falls back to generic labels.
    }
  }, [project?.id])

  // Decide whether to prompt a client for their name. We ask whenever we don't already
  // know who they are — regardless of auth mode — so the check is per-project and never
  // goes stale across project switches (auth mode isn't refreshed on switch). Skips
  // admins, anyone who already chose a name for this project, and OTP sessions whose
  // email maps to a project recipient (auto-derived).
  useEffect(() => {
    if (isAdminSession) { setNameCaptureState('done'); return }
    if (!isAuthenticated || !project) return

    const existing = loadCommentIdentity()
    if (existing.authorName || existing.recipientId) { setNameCaptureState('done'); return }

    if (otpSessionEmail && Array.isArray(project.recipients)) {
      const normalized = otpSessionEmail.toLowerCase().trim()
      const match = (project.recipients as any[]).find(
        (r) => String(r?.email || '').toLowerCase().trim() === normalized,
      )
      if (match) {
        persistCommentIdentity(String(match.name || otpSessionEmail).trim(), String(match.id))
        setNameCaptureState('done')
        return
      }
    }

    setNameCaptureState('needed')
  }, [isAdminSession, isAuthenticated, project, otpSessionEmail, loadCommentIdentity, persistCommentIdentity])

  // A typed (non-recipient) name is registered as a project recipient — same endpoint
  // the comment name picker uses — so attribution gets a real recipientId and the name
  // shows up for admins/other clients. Best-effort: on failure we keep the name-only
  // identity rather than blocking entry to the page.
  const handleNameChosen = useCallback(async (name: string, recipientId: string | null) => {
    let trimmed = name.trim()
    let resolvedId = recipientId

    if (!resolvedId && trimmed) {
      const match = ((project?.recipients as any[]) || []).find(
        (r) => String(r?.name || '').trim().toLowerCase() === trimmed.toLowerCase(),
      )
      if (match?.id) {
        resolvedId = String(match.id)
        trimmed = String(match.name).trim()
      }
    }

    if (!resolvedId && trimmed && !isAdminSession && shareToken) {
      try {
        const response = await apiFetch(`/api/share/${token}/recipients`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${shareToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        const data = await response.json().catch(() => null)
        const id = response.ok ? String(data?.recipient?.id || '') : ''
        if (id) {
          resolvedId = id
          window.dispatchEvent(
            new CustomEvent('shareRecipientsChanged', {
              detail: { action: 'add', recipient: { id, name: String(data?.recipient?.name || trimmed) } },
            })
          )
        }
      } catch {
        // Network failure — proceed with a name-only identity.
      }
    }

    persistCommentIdentity(trimmed, resolvedId)
    setNameCaptureState('done')
  }, [project, isAdminSession, shareToken, token, persistCommentIdentity])

  const handleCreateUploadFolder = useCallback(async (parentPath: string, folderName: string) => {
    const authHeader: Record<string, string> = !isAdminSession && shareToken ? { Authorization: `Bearer ${shareToken}` } : {}
    const identity = loadCommentIdentity()
    const response = await apiFetch(`/api/share/${token}/uploads`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentPath,
        folderName,
        recipientId: identity.recipientId,
        authorName: identity.authorName,
      }),
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Unable to create folder')
    }

    await fetchDownloadableFiles()
  }, [isAdminSession, shareToken, token, fetchDownloadableFiles, loadCommentIdentity])

  const handleApproveVideo = useCallback(async (file: DownloadableFile) => {
    if (!file.videoId) throw new Error('Video ID is missing')
    if (!project?.id) throw new Error('Project not loaded')

    const url = `/api/projects/${project.id}/approve`
    const identity = loadCommentIdentity()
    const approveBody = JSON.stringify({
      selectedVideoId: file.videoId,
      recipientId: !isAdminSession ? identity.recipientId : null,
      authorName: !isAdminSession ? identity.authorName : null,
    })
    const response = isAdminSession
      ? await apiFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: approveBody,
        })
      : shareToken
        ? await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${shareToken}`,
            },
            body: approveBody,
          })
        : await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: approveBody,
          })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to approve video')
    }

    markVideoApproved(file.videoId)
    window.dispatchEvent(new CustomEvent('videoApprovalChanged', { detail: { videoId: file.videoId } }))
    void fetchProjectData()
    void fetchDownloadableFiles()
  }, [project?.id, isAdminSession, shareToken, markVideoApproved, fetchProjectData, fetchDownloadableFiles, loadCommentIdentity])

  const handleUploadFiles = useCallback(async (folderPath: string, files: File[]) => {
    if (!Array.isArray(files) || files.length === 0) return
    uploadCancelRequestedRef.current = false

    let authToken: string | null = !isAdminSession ? (loadShareToken(storageKey) || shareToken) : null
    const useS3Multipart = await isS3Mode()
    const uploadIdentity = loadCommentIdentity()

    const performRequest = async (
      url: string,
      init: RequestInit,
      retryOn401: boolean,
    ): Promise<Response> => {
      const tokenToUse = !isAdminSession ? authToken : null
      const authHeader: Record<string, string> = tokenToUse ? { Authorization: `Bearer ${tokenToUse}` } : {}
      const headers = { ...authHeader, ...(init.headers as Record<string, string> | undefined) }

      let response = await apiFetch(url, {
        ...init,
        headers,
      })

      if (retryOn401 && response.status === 401 && !isAdminSession) {
        await fetchProjectData(tokenToUse)
        authToken = loadShareToken(storageKey) || shareToken
        const refreshedAuthHeader: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {}
        response = await apiFetch(url, {
          ...init,
          headers: {
            ...refreshedAuthHeader,
            ...(init.headers as Record<string, string> | undefined),
          },
        })
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
            `/api/share/${token}/uploads/s3/presign`,
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
              `/api/share/${token}/uploads/s3/abort`,
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
            `/api/share/${token}/uploads/s3/complete`,
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
                recipientId: uploadIdentity.recipientId,
                authorName: uploadIdentity.authorName,
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
          if (uploadIdentity.recipientId) formData.append('recipientId', uploadIdentity.recipientId)
          if (uploadIdentity.authorName) formData.append('authorName', uploadIdentity.authorName)

          const uploadWithProgress = (bearerToken: string | null): Promise<{ status: number; responseText: string }> => {
            return new Promise((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'))
                return
              }

              const xhr = new XMLHttpRequest()
              xhr.open('POST', `/api/share/${token}/uploads/files`)
              if (bearerToken) {
                xhr.setRequestHeader('Authorization', `Bearer ${bearerToken}`)
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
                  ? {
                      ...item,
                      status: 'transferring',
                      progressPercent: Math.max(10, item.progressPercent),
                      errorMessage: null,
                    }
                  : item
              )))

              xhr.send(formData)
            })
          }

          let uploadResult = await uploadWithProgress(!isAdminSession ? authToken : null)

          if (uploadResult.status === 401 && !isAdminSession) {
            await fetchProjectData(!isAdminSession ? authToken : null)
            authToken = loadShareToken(storageKey) || shareToken
            uploadResult = await uploadWithProgress(authToken)
          }

          if (uploadResult.status < 200 || uploadResult.status >= 300) {
            let errorMessage = 'Upload failed'
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
  }, [
    isAdminSession,
    shareToken,
    token,
    storageKey,
    fetchDownloadableFiles,
    fetchProjectData,
    loadCommentIdentity,
  ])

  const handleDeleteUploadFile = useCallback(async (fileId: string) => {
    if (!isAdminSession) throw new Error('Only admins can delete uploads')
    if (!fileId) return

    const response = await apiFetch(`/api/share/${token}/uploads?fileId=${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Unable to delete file')
    }

    await fetchDownloadableFiles()
  }, [isAdminSession, token, fetchDownloadableFiles])

  const handleDeleteUploadFolder = useCallback(async (folderPath: string) => {
    if (!isAdminSession) throw new Error('Only admins can delete uploads')
    if (!folderPath) return

    const response = await apiFetch(`/api/share/${token}/uploads?folderPath=${encodeURIComponent(folderPath)}`, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Unable to delete folder')
    }

    await fetchDownloadableFiles()
  }, [isAdminSession, token, fetchDownloadableFiles])

  const handleRenameUploadFolder = useCallback(async (folderPath: string, folderName: string) => {
    if (!isAdminSession) throw new Error('Only admins can rename upload folders')
    if (!folderPath) return

    const response = await apiFetch(`/api/share/${token}/uploads`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, folderName }),
    })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error((payload && typeof payload?.error === 'string') ? payload.error : 'Unable to rename folder')
    }

    await fetchDownloadableFiles()
  }, [isAdminSession, token, fetchDownloadableFiles])

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

  useEffect(() => {
    if (isAdminSession) return
    if (!isAuthenticated) return
    if (!shareToken) return
    if (!hasAnyActiveTransfers) return

    const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000
    const intervalId = window.setInterval(() => {
      const persisted = loadShareToken(storageKey)
      void fetchProjectData(persisted || shareToken)
    }, KEEPALIVE_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [fetchProjectData, hasAnyActiveTransfers, isAdminSession, isAuthenticated, shareToken, storageKey])

  // Proactively show the re-auth form when the share token is about to expire,
  // so clients aren't left staring at a broken page that 401s on every request.
  // If an upload or download is active the reset is deferred: the effect re-runs
  // once hasAnyActiveTransfers goes false, at which point msUntilExpiry ≤ 0 and
  // we reset immediately so the auth screen appears as soon as the transfer ends.
  useEffect(() => {
    if (!shareToken || !isAuthenticated || isAdminSession) return

    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      const b64 = shareToken.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
      if (b64) {
        const payload = JSON.parse(atob(b64))
        if (typeof payload.exp === 'number') {
          const msUntilExpiry = payload.exp * 1000 - Date.now()
          const resetToAuthScreen = () => {
            // Don't interrupt an active upload or download.
            if (hasAnyActiveTransfers) return
            void handleSessionExpired()
          }
          if (msUntilExpiry <= 0) {
            resetToAuthScreen()
          } else {
            timer = setTimeout(resetToAuthScreen, msUntilExpiry)
          }
        }
      }
    } catch {
      // ignore JWT parse errors — the next API call will handle expiry reactively
    }

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [shareToken, isAuthenticated, isAdminSession, hasAnyActiveTransfers, handleSessionExpired])

  const sidebarVideosByName = useMemo(() => {
    const base = Object.keys(allVideosByName).length > 0 ? allVideosByName : (project?.videosByName || {})
    // The tokenized copies in `allVideosByName` cache the `approved` flag as it was
    // when they were tokenized, and a re-tokenization race (loadTokens caching the
    // still-stale active video before the preload rebuild) can leave a just-(un)approved
    // version showing its old state in the sidebar. `project.videosByName` is always the
    // fresh source of truth (refetched on every approval event), so overlay its approval
    // flags onto the tokenized copies while keeping their thumbnail/stream URLs.
    const fresh = project?.videosByName
    if (!fresh) return base
    const merged: Record<string, any[]> = {}
    for (const [name, versions] of Object.entries(base)) {
      const freshVersions = (fresh as Record<string, any[]>)[name]
      if (!Array.isArray(freshVersions)) { merged[name] = versions as any[]; continue }
      merged[name] = (versions as any[]).map((v) => {
        const f = freshVersions.find((fv) => fv.id === v.id)
        return f ? { ...v, approved: f.approved, approvedAt: f.approvedAt, unapprovedAt: f.unapprovedAt } : v
      })
    }
    return merged
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

    if (file.type === 'upload-file' && file.uploadFileId) {
      const tokenizedUrls = await getUploadAccessUrl(file.uploadFileId)
      if (tokenizedUrls?.previewUrl) {
        return tokenizedUrls.previewUrl
      }
      // Do not fall back to downloadUrl — videos without a ready preview should show the icon fallback
      return null
    }

    if (file.type === 'video' && file.videoId) {
      return filePreviewByVideoId.get(file.videoId) || null
    }

    if (file.type !== 'asset' || !file.videoId || !file.assetId) return null

    try {
      const url = `/api/videos/${file.videoId}/assets/${file.assetId}/download-token`
      const response = isAdminSession
        ? await apiFetch(url, { method: 'POST' })
        : shareToken
          ? await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${shareToken}` } })
          : await fetch(url, { method: 'POST' })

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
      if (typeof (data as any)?.playbackUrl === 'string' && (data as any).playbackUrl) {
        return String((data as any).playbackUrl)
      }
      return null
    } catch {
      return null
    }
  }, [filePreviewByVideoId, getUploadAccessUrl, isAdminSession, requestFilesRefresh, shareToken])

  const resolveDownloadablePlaybackUrl = useCallback(async (file: DownloadableFile): Promise<string | null> => {
    if (file.type === 'upload-file' && file.uploadFileId) {
      const tokenizedUrls = await getUploadAccessUrl(file.uploadFileId)
      if (typeof tokenizedUrls?.playbackUrl === 'string' && tokenizedUrls.playbackUrl) {
        return tokenizedUrls.playbackUrl
      }
      if (typeof tokenizedUrls?.downloadUrl === 'string' && tokenizedUrls.downloadUrl) {
        return tokenizedUrls.downloadUrl
      }
      return null
    }

    if (file.type !== 'asset' || !file.videoId || !file.assetId) return null

    try {
      const url = `/api/videos/${file.videoId}/assets/${file.assetId}/download-token`
      const response = isAdminSession
        ? await apiFetch(url, { method: 'POST' })
        : shareToken
          ? await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${shareToken}` } })
          : await fetch(url, { method: 'POST' })

      if (!response.ok) return null
      const data = await response.json().catch(() => ({}))
      // Prefer the proxy-robust HLS master playlist (ends in .m3u8 → the lightbox's useHlsVideo
      // detects it); fall back to the single-file MP4 playback URL.
      if (typeof (data as any)?.hlsUrl === 'string' && (data as any).hlsUrl) {
        return String((data as any).hlsUrl)
      }
      if (typeof (data as any)?.playbackUrl === 'string' && (data as any).playbackUrl) {
        return String((data as any).playbackUrl)
      }
      return null
    } catch {
      return null
    }
  }, [getUploadAccessUrl, isAdminSession, shareToken])

  const fetchTokensForVideos = useCallback(async (videos: any[]) => {
    if (project?.enableVideos === false) return videos
    if (!shareToken) return videos

    // Prefer the direct-to-R2 stream URL when the server provides one (Option B);
    // otherwise fall back to the token-gated /api/content redirect.
    const buildStreamUrl = (s: { token: string; streamUrl: string }): string =>
      s.streamUrl || (s.token ? `/api/content/${s.token}` : '')
    const emptyStream = () => Promise.resolve({ token: '', streamUrl: '', hlsUrl: '', hlsAbr: false })

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
            // Prefer the thumbnail URL minted into the share payload (no extra round-trip).
            // Fall back to the per-session cache, then to an on-demand token fetch (e.g. for
            // videos whose thumbnail finished processing after the payload was built).
            let thumbnailUrl = (typeof video.thumbnailUrl === 'string' && video.thumbnailUrl)
              ? video.thumbnailUrl
              : (sidebarVideoCacheRef.current.get(video.id)?.thumbnailUrl ?? null)
            const needsThumbnailToken = !thumbnailUrl && !!video.hasThumbnail

            // Unapproved direct-to-HLS videos have no MP4 PREVIEW_* files, so the
            // per-resolution fetches below are all skipped and we'd never obtain the HLS
            // URL. In that case fetch one streaming token to mint the HLS master (the
            // token response carries hlsUrl regardless of which streaming quality is
            // requested). Approved videos get it from the original fetch instead.
            const noMp4Previews = !video.preview480Path && !video.preview720Path && !video.preview1080Path

            // Everything this video needs is requested concurrently so the batching layer
            // coalesces the whole pass — across all videos — into one (chunked) POST.
            // Approval unlocks original download, but playback should use preview streams;
            // only request tokens for resolutions that have an actual preview file so that
            // the VideoPlayer's quality selector reflects what is genuinely available.
            const [orig, s480, s720, s1080, hls, thumbToken, vttToken, spriteToken, subtitlesToken] = await Promise.all([
              video.approved ? fetchVideoStream(video.id, 'original') : emptyStream(),
              video.preview480Path ? fetchVideoStream(video.id, '480p') : emptyStream(),
              video.preview720Path ? fetchVideoStream(video.id, '720p') : emptyStream(),
              video.preview1080Path ? fetchVideoStream(video.id, '1080p') : emptyStream(),
              (!video.approved && noMp4Previews) ? fetchVideoStream(video.id, '720p') : emptyStream(),
              needsThumbnailToken ? fetchVideoToken(video.id, 'thumbnail') : Promise.resolve(''),
              video.timelinePreviewsReady ? fetchVideoToken(video.id, 'timeline-vtt') : Promise.resolve(''),
              video.timelinePreviewsReady ? fetchVideoToken(video.id, 'timeline-sprite') : Promise.resolve(''),
              video.hasSubtitles ? fetchVideoToken(video.id, 'subtitles-vtt') : Promise.resolve(''),
            ])

            const downloadToken: string | null = video.approved ? (orig.token || null) : null
            // Do NOT fall back to the original for the preview streams; streamUrlOriginal
            // covers the no-preview case (unapproved videos never get an original).
            const streamUrlOriginal = video.approved ? buildStreamUrl(orig) : ''
            const streamUrl480p = buildStreamUrl(s480)
            const streamUrl720p = buildStreamUrl(s720)
            const streamUrl1080p = buildStreamUrl(s1080)
            const hlsUrl = s720.hlsUrl || s1080.hlsUrl || s480.hlsUrl || orig.hlsUrl || hls.hlsUrl || ''
            const hlsAbr = s720.hlsAbr || s1080.hlsAbr || s480.hlsAbr || orig.hlsAbr || hls.hlsAbr || false

            if (!thumbnailUrl && thumbToken) {
              thumbnailUrl = `/api/content/${thumbToken}`
            }

            const timelineVttUrl = vttToken ? `/api/content/${vttToken}` : null
            const timelineSpriteUrl = spriteToken ? `/api/content/${spriteToken}` : null
            const subtitlesVttUrl = subtitlesToken ? `/api/content/${subtitlesToken}` : null

            const tokenized = {
              ...video,
              streamUrl480p,
              streamUrl720p,
              streamUrl1080p,
              streamUrlOriginal,
              hlsUrl,
              hlsAbr,
              downloadUrl: downloadToken ? `/api/content/${downloadToken}?download=true` : null,
              thumbnailUrl,
              timelineVttUrl,
              timelineSpriteUrl,
              subtitlesVttUrl,
            }

            // A rate-limited pass produces empty stream URLs — caching those would
            // poison playback until the next full refresh. Leave the entry uncached
            // so the next natural trigger (after the backoff lapses) re-mints it.
            if (!isVideoTokenBackoffActive()) {
              tokenCacheRef.current.set(video.id, tokenized)
              sidebarVideoCacheRef.current.set(video.id, tokenized)
            }
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
  }, [shareToken, project, fetchVideoToken, fetchVideoStream, isVideoTokenBackoffActive])

  const refreshViewVideoTokens = useCallback(async (force = false) => {
    if (project?.enableVideos === false) return
    if (!project?.videosByName) return
    if (!shareToken) return
    // While rate-limited, a refresh (even a forced one from an error handler)
    // can only produce more 429s — wait the window out.
    if (isVideoTokenBackoffActive()) return

    const now = Date.now()
    // Prevent rapid duplicate refreshes from focus + visibilitychange firing together.
    if (!force && now - lastVideoTokenRefreshAtRef.current < 30_000) {
      return
    }
    lastVideoTokenRefreshAtRef.current = now

    const allVideos = Object.values(project.videosByName).flat() as any[]
    if (allVideos.length === 0) return

    tokenCacheRef.current.clear()
    tokenRequestCacheRef.current.clear()
    sidebarVideoCacheRef.current.clear()
    sidebarThumbnailRequestCacheRef.current.clear()

    const tokenized = await fetchTokensForVideos(allVideos)
    const tokenizedById = new Map<string, any>()
    tokenized.forEach((video: any) => {
      if (video?.id) tokenizedById.set(String(video.id), video)
    })

    const refreshedVideosByName = Object.fromEntries(
      Object.entries(project.videosByName).map(([name, versions]: [string, any]) => {
        const refreshed = (Array.isArray(versions) ? versions : []).map((video: any) => {
          const cached = tokenizedById.get(String(video.id))
          return cached || video
        })
        return [name, refreshed]
      })
    )

    setAllVideosByName(refreshedVideosByName)

    if (activeVideoName && refreshedVideosByName[activeVideoName]) {
      setActiveVideosRaw(refreshedVideosByName[activeVideoName])
      setActiveVideos(refreshedVideosByName[activeVideoName])
    }
  }, [activeVideoName, fetchTokensForVideos, project?.enableVideos, project?.videosByName, shareToken, isVideoTokenBackoffActive])

  // Safety net: if the <video> element fails to load its stream (e.g. an expired
  // /api/content token after a session hiccup), drop the stale cache entry and re-mint
  // fresh tokens for the current videos so playback can recover without a full reload.
  const handleVideoStreamError = useCallback((videoId: string) => {
    if (isAdminSession) return
    if (!shareTokenRef.current) return
    // Throttle: a persistently failing stream (e.g. while rate-limited) fires
    // error events on every retry; each forced refresh costs a full token pass,
    // so repeated errors must not stack into a request flood.
    const now = Date.now()
    if (now - lastStreamErrorRefreshAtRef.current < 15_000) return
    lastStreamErrorRefreshAtRef.current = now
    tokenCacheRef.current.delete(videoId)
    tokenRequestCacheRef.current.delete(videoId)
    sidebarVideoCacheRef.current.delete(videoId)
    void refreshViewVideoTokens(true)
  }, [isAdminSession, refreshViewVideoTokens])

  useEffect(() => {
    let isMounted = true

    async function loadTokens() {
      if (!activeVideosRaw || activeVideosRaw.length === 0) {
        setTokensLoading(false)
        return
      }
      if (!shareToken) {
        setTokensLoading(true)
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
  }, [activeVideosRaw, shareToken, fetchTokensForVideos])

  // Preload thumbnails for ALL videos on page load (ensures sidebar thumbnails are visible immediately)
  useEffect(() => {
    if (!project?.videosByName || !shareToken) return

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
  }, [project?.videosByName, shareToken, fetchTokensForVideos])

  // ── Comprehensive content-token refresh ──────────────────────────────────
  // Called by useContentImageRefresh on: image load errors, periodic timer,
  // and visibility change (tab hidden >30 s → visible).  Covers video
  // thumbnails/sprites, album photos, and upload previews.
  const refreshAllContentTokens = useCallback(() => {
    // Clear all token caches so fetches produce fresh URLs.
    clearAllShareCaches()

    // Refresh video tokens (thumbnails, sprites, VTT).
    void refreshViewVideoTokens(true)

    // Refresh downloadable files (album photo tokens, upload access URLs).
    void fetchDownloadableFiles()

    // Refresh album list (sidebar album thumbnail URLs).
    if (project?.slug) {
      void fetchAlbums(shareToken)
    }
  }, [clearAllShareCaches, refreshViewVideoTokens, fetchDownloadableFiles, fetchAlbums, project?.slug, shareToken])

  // Global content-image error capture + proactive periodic token refresh + visibility-change refresh.
  useContentImageRefresh({
    onRefresh: refreshAllContentTokens,
    enabled: isAuthenticated,
  })

  // Also keep the legacy visibility/focus handler for non-admin sessions to ensure
  // video tokens are refreshed on tab focus (covers the gap before the 30 s
  // away threshold in useContentImageRefresh's visibility handler).
  useEffect(() => {
    if (!isAuthenticated || isAdminSession) return
    if (!shareToken) return

    const handleFocus = () => {
      void refreshViewVideoTokens()
    }

    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [isAdminSession, isAuthenticated, refreshViewVideoTokens, shareToken])

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
    const wasInAlbum = !!activeAlbumId
    setActiveAlbumId(null)
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
    setRequestedFilesFolderName(videoName)
    setDesktopContentTab('files')
    if (wasInAlbum && shareToken) {
      void fetch(`/api/share/${token}/activity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shareToken}` },
        body: JSON.stringify({ activityType: 'VIEWING_SHARE_PAGE' }),
      }).catch(() => {})
    }
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
    if (shareToken) {
      void fetch(`/api/share/${token}/activity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shareToken}` },
        body: JSON.stringify({ activityType: 'VIEWING_ALBUM', albumId, albumName: album?.name ?? null }),
      }).catch(() => {})
    }
  }

  // Open the video version / album referenced by a Project Activity entry.
  const handleOpenActivityTarget = (target: { videoId?: string; videoName?: string; albumId?: string; uploads?: { folderPath?: string } }) => {
    if (target.albumId) {
      handleAlbumSelect(String(target.albumId))
      return
    }
    if (target.uploads) {
      handleUploadsSelect(target.uploads.folderPath)
      return
    }
    if (target.videoId) {
      if (!confirmShareDraftNavigation()) return
      if (target.videoName) activateVideoFolder(String(target.videoName))
      setDesktopContentTab('view')
      const videoId = String(target.videoId)
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId } }))
        window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId } }))
        window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId, videoVersion: null, autoPlay: true } }))
      }, 0)
    }
  }

  // Open a specific UPLOADS folder in the Files browser (toggles back to the project
  // root when it is already active). `folderPath` is the folder's top-level relative
  // path; empty/undefined opens the UPLOADS root.
  const handleUploadsSelect = (folderPath?: string) => {
    if (!confirmShareDraftNavigation()) return
    const target = folderPath ? `UPLOADS / ${folderPath}` : 'UPLOADS'
    const current = String(requestedFilesFolderName || '').trim()
    const isAlreadyActive = desktopContentTab === 'files' && current === target
    if (isAlreadyActive) {
      setRequestedFilesFolderName(null)
      return
    }
    setActiveVideoName('')
    setActiveVideosRaw([])
    setActiveAlbumId(null)
    setRequestedFilesFolderName(target)
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
    // Unknown folder (e.g. nested upload path) — clear the sidebar highlight.
    setActiveVideoName('')
    setActiveVideosRaw([])
    setActiveAlbumId(null)
  }, [albums, project?.videosByName])

  useEffect(() => {
    if (!project) return
    void fetchAlbums()
  }, [project, shareToken, fetchAlbums])

  useEffect(() => {
    if (!project || !isAuthenticated) return
    void fetchDownloadableFiles()
  }, [project, isAuthenticated, shareToken, fetchDownloadableFiles])

  useEffect(() => {
    if (!project || !isAuthenticated) {
      setSwitchableProjects([])
      setSwitchProjectsError(null)
      return
    }

    void fetchSwitchableProjects()
  }, [project, isAuthenticated, fetchSwitchableProjects])

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault()
    if (!email) return

    setSendingOtp(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })

      const data = await response.json()

      if (response.ok) {
        setOtpSent(true)
        setError('') // Clear any previous errors
      } else {
        // Show generic message to prevent email enumeration
        setError(data.error || 'Failed to send code. Please try again.')
      }
    } catch (error) {
      setError('An error occurred. Please try again.')
    } finally {
      setSendingOtp(false)
    }
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !otp) return

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: otp }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }

        // Remember the email used for OTP in this tab session (no cookies)
        const normalizedEmail = email.toLowerCase().trim()
        try {
          if (otpEmailStorageKey) {
            sessionStorage.setItem(otpEmailStorageKey, normalizedEmail)
          }
        } catch {
          // ignore
        }

        setIsAuthenticated(true)

        // Clear all caches tied to the previous (expired) session before fetching fresh data.
        clearAllShareCaches()
        await fetchProjectData(data.shareToken)
        void fetchDownloadableFiles(data.shareToken)
      } else {
        setError('Invalid or expired code. Please try again.')
      }
    } catch (error) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }
        setPassword('')
        setIsAuthenticated(true)

        // Clear all caches tied to the previous (expired) session before fetching fresh data.
        clearAllShareCaches()
        await fetchProjectData(data.shareToken)
        void fetchDownloadableFiles(data.shareToken)
      } else {
        setError('Incorrect password')
      }
    } catch (error) {
      setError('An error occurred')
    } finally {
      setLoading(false)
    }
  }

  // Show loading state
  if (isPasswordProtected === null) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // Show authentication prompt
  if (isPasswordProtected && !isAuthenticated) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card border-border w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              {hasLogo ? (
                mainCompanyDomain ? (
                  <a href={mainCompanyDomain} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={logoSrc}
                      alt="Company Logo"
                      className="max-h-16 max-w-[200px] object-contain"
                    />
                  </a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoSrc}
                    alt="Company Logo"
                    className="max-h-16 max-w-[200px] object-contain"
                  />
                )
              ) : (
                <Lock className="w-12 h-12 text-muted-foreground" />
              )}
            </div>
            <CardTitle className="text-foreground">Authentication Required</CardTitle>
            <p className="text-muted-foreground text-sm mt-2">
              {authMode === 'PASSWORD' && 'Please enter the password to continue.'}
              {authMode === 'OTP' && 'Enter your email to receive an access code.'}
              {authMode === 'BOTH' && 'Choose your preferred authentication method.'}
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Password Authentication - hide when OTP code is being entered */}
            {(authMode === 'PASSWORD' || authMode === 'BOTH') && !otpSent && (
              <div className="space-y-4">
                {authMode === 'BOTH' && (
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">Password</p>
                  </div>
                )}
                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <PasswordInput
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus={authMode === 'PASSWORD'}
                    autoComplete="off"
                  />
                  <Button
                    type="submit"
                    variant="default"
                    size="default"
                    disabled={loading || !password}
                    className="w-full"
                  >
                    <Check className="w-4 h-4 mr-2" />
                    {loading ? 'Verifying...' : 'Submit'}
                  </Button>
                </form>
              </div>
            )}

            {/* Divider for BOTH mode - hide when OTP code is being entered */}
            {authMode === 'BOTH' && !otpSent && (
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border"></div>
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or</span>
                </div>
              </div>
            )}

            {/* OTP Authentication */}
            {(authMode === 'OTP' || authMode === 'BOTH') && (
              <div className="space-y-4">
                {authMode === 'BOTH' && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-muted-foreground" />
                    <p className="text-sm font-medium text-foreground">Email Verification</p>
                  </div>
                )}
                {!otpSent ? (
                  <form onSubmit={handleSendOtp} className="space-y-4">
                    <Input
                      type="email"
                      placeholder="Enter your email address"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoFocus={authMode === 'OTP'}
                      required
                    />
                    <Button
                      type="submit"
                      variant="default"
                      size="default"
                      disabled={sendingOtp || !email}
                      className="w-full"
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {sendingOtp ? 'Sending Code...' : 'Send Verification Code'}
                    </Button>
                  </form>
                ) : (
                  <form onSubmit={handleOtpSubmit} className="space-y-4">
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground text-center">
                        If a recipient exists with <span className="font-medium text-foreground">{email}</span>, you will receive a verification code shortly.
                      </p>
                      <OTPInput
                        value={otp}
                        onChange={setOtp}
                        disabled={loading}
                        autoFocus
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        onClick={() => {
                          setOtpSent(false)
                          setOtp('')
                          setError('')
                        }}
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button
                        type="submit"
                        variant="default"
                        size="default"
                        disabled={loading || otp.length !== 6}
                        className="flex-1"
                      >
                        <Check className="w-4 h-4 mr-2" />
                        {loading ? 'Verifying...' : 'Verify'}
                      </Button>
                    </div>
                    {showOtpHint && (
                      <div className="mt-3 p-3 bg-warning-visible border border-warning-visible rounded-lg">
                        <p className="text-xs text-warning leading-relaxed">
                          Didn&apos;t receive a code? It&apos;s possible you haven&apos;t been added to this project. Please reach out to the person who gave you this link, and they can coordinate with us to get you access.
                        </p>
                      </div>
                    )}
                  </form>
                )}
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="p-3 bg-destructive-visible border border-destructive-visible rounded-lg">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // Show server error with retry
  if (loadError) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card border-border w-full max-w-md">
          <CardContent className="py-12 text-center space-y-4">
            <p className="text-foreground font-semibold">Temporarily Unavailable</p>
            <p className="text-muted-foreground text-sm">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setLoadError(null)
                setIsPasswordProtected(null)
              }}
            >
              Try Again
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Show project not found
  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card border-border w-full max-w-md">
          <CardContent className="py-12 text-center">
            <p className="text-foreground font-semibold">Share Link Not Found</p>
            <p className="text-muted-foreground mt-2 text-sm">This link may be incorrect or the project may no longer be available.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter to READY videos first
  let readyVideos = (project?.enableVideos === false)
    ? []
    : activeVideos.filter((v: any) => v.status === 'READY')

  // If any video is approved, show ONLY approved videos (for both admin and client)
  const hasApprovedVideo = readyVideos.some((v: any) => v.approved)
  if (hasApprovedVideo) {
    readyVideos = readyVideos.filter((v: any) => v.approved)
  }

  const hasMultipleVideos = project.videosByName && Object.keys(project.videosByName).length > 1

  // Filter comments to only show comments for active videos
  const activeVideoIds = new Set(activeVideos.map((v: any) => v.id))
  const filteredComments = comments.filter((comment: any) => {
    // Show general comments (no videoId) or comments for active videos
    return !comment.videoId || activeVideoIds.has(comment.videoId)
  })

  // Video-only mode: hidden feedback (no scrollable comments below).
  // Use overflow-hidden on mobile so the flex layout constrains the video within the
  // viewport minus the mobile sidebar height, preventing the bottom from being clipped.
  const isVideoOnlyShareMode = project.hideFeedback

  // Header breadcrumb computed values
  const activeAlbum = albums.find((a: any) => String(a.id) === activeAlbumId) || null
  const headerVersion = readyVideos.find((v: any) => v.id === headerVersionId) || readyVideos[0] || null
  const canSwitchProjects = switchableProjects.length > 0
  const isOlderVersionSelected = readyVideos.length > 1 && headerVersionId !== null && headerVersionId !== readyVideos[0]?.id
  const clientSwitcherProjects: ShareProjectOption[] = switchableProjects.map((project) => ({
    id: String(project.id),
    title: String(project.title || ''),
    status: String(project.status || ''),
  }))

  // Sorted video names for the video dropdown (same order as sidebar)
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
    <div
      className="h-dvh min-h-0 bg-background flex flex-col overflow-hidden"
      style={{ '--admin-header-height': '56px' } as React.CSSProperties}
    >
      {nameCaptureState === 'needed' && (
        <ShareNameCaptureModal
          recipients={(project.recipients as any[]) || []}
          onConfirm={handleNameChosen}
        />
      )}
      {/* Sticky breadcrumb header — spans full width above sidebar + content */}
      <div className="shrink-0 h-12 my-[4px] border border-border bg-card rounded-lg flex items-center pl-4 pr-3 lg:pr-0 gap-1.5 text-sm overflow-x-auto z-40">

        {/* Project section */}
        <span className="text-muted-foreground whitespace-nowrap hidden sm:inline shrink-0">Project:</span>
        {canSwitchProjects ? (
          <ShareProjectSwitcher
            currentProjectId={String(project.id)}
            currentProjectTitle={String(project.title || '')}
            currentProjectStatus={String(project.status || '')}
            projects={clientSwitcherProjects}
            loading={switchProjectsLoading || Boolean(switchingProjectId)}
            error={switchProjectsError}
            searchPlaceholder="Search projects..."
            onSelectProject={(target) => {
              const projectToOpen = switchableProjects.find((item) => item.id === target.id)
              if (projectToOpen) {
                void handleProjectSwitch(projectToOpen)
              }
            }}
          />
        ) : (
          <span className="text-foreground font-medium whitespace-nowrap shrink-0 max-w-[30%] truncate" title={project.title}>{project.title}</span>
        )}

        {isUploadsFilesBrowse ? (
          <>
            <span className="text-muted-foreground shrink-0">/</span>
            <span
              className="text-foreground whitespace-nowrap shrink-0 max-w-[40%] truncate"
              title={uploadsHeaderPathDisplay}
            >
              {uploadsHeaderPathDisplay}
            </span>
          </>
        ) : null}

        {/* Video / Album section */}
        {(activeVideoName || activeAlbum) && !isUploadsFilesBrowse && !(desktopContentTab === 'files' && !requestedFilesFolderName) && (
          <>
            <span className="text-muted-foreground shrink-0">/</span>
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
                <SelectTrigger className="h-7 text-sm w-auto shrink-0 gap-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mediaOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : !activeAlbum ? (
              <span
                className="text-foreground whitespace-nowrap shrink-0 max-w-[30%] truncate"
                title={activeVideoName}
              >
                {activeVideoName}
              </span>
            ) : (
              <span
                className="text-foreground whitespace-nowrap shrink-0 max-w-[30%] truncate"
                title={activeAlbum.name}
              >
                {activeAlbum.name}
              </span>
            )}
          </>
        )}

        {/* Version section — hidden in files mode */}
        {!activeAlbumId && readyVideos.length > 0 && desktopContentTab !== 'files' && (
          <>
            <span className="text-muted-foreground shrink-0">/</span>
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
                <SelectTrigger className="h-7 text-sm w-auto shrink-0 gap-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {readyVideos.map((v: any) => (
                    <SelectItem key={v.id} value={v.id}>{v.versionLabel}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-foreground whitespace-nowrap shrink-0">{headerVersion?.versionLabel || '—'}</span>
            )}
            {isOlderVersionSelected && (
              <span className="text-warning text-xs whitespace-nowrap shrink-0">(Newer version available)</span>
            )}
          </>
        )}

      </div>

      {/* Main content row: sidebar + content area */}
      <div className={cn(
        'flex-1 min-h-0 flex flex-col lg:flex-row lg:gap-1 lg:overflow-hidden',
        desktopContentTab === 'files' ? 'gap-2 lg:gap-1' : 'gap-0',
        isVideoOnlyShareMode ? 'overflow-hidden' : 'overflow-y-auto',
      )}>
      {/* Video Sidebar - contains both desktop and mobile versions internally */}
      <VideoSidebar
        videosByName={sidebarVideosByName}
        activeVideoName={activeVideoName}
        onVideoSelect={handleVideoSelect}
        hideApprovalGrouping={false}
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
        className="w-64 shrink-0"
        hasLogo={hasLogo}
        mainCompanyDomain={mainCompanyDomain}
        downloadableFiles={downloadableFilesWithOptimisticUploads}
        onDownloadFile={handleDownloadFile}
        onDownloadFiles={handleDownloadFiles}
        sharedDownloadProgress={downloadTransferSummary}
        isSharedDownloadActive={hasActiveDownloadTransfers}
        transferItems={transferItemsCombined}
        transferSummary={transferSummaryCombined}
        transferPanelVersion={transferPanelVersionCombined}
        onCancelActiveTransfers={cancelActiveTransfersCombined}
        onClearCompletedTransfers={clearCompletedTransfersCombined}
        hasApprovableVideos={hasApprovableVideos}
        showDesktopTabBar={false}
        desktopActiveTab="for-review"
        showUploadsInView={true}
        onUploadsSelect={handleUploadsSelect}
        selectedFileIds={selectedFileIds}
        onSelectedFileIdsChange={setSelectedFileIds}
        activeFilesFolderName={requestedFilesFolderName}
        shareSlug={token}
        shareToken={shareToken}
        onOpenVideoVersion={(file, folderName) => {
          if (file.type !== 'video' || !file.videoId) return
          if (folderName) {
            activateVideoFolder(folderName)
          }
          setDesktopContentTab('view')
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('selectVideoForComments', { detail: { videoId: file.videoId } }))
            window.dispatchEvent(new CustomEvent('videoTimeUpdated', { detail: { time: 0, videoId: file.videoId } }))
            window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: file.videoId, videoVersion: null, autoPlay: true } }))
          }, 0)
        }}
        onApproveVideo={handleApproveVideo}
      />

      {/* Main Content Area */}
      <div className={cn(
        'flex-1 flex flex-col min-w-0 min-h-0',
        activeAlbumId ? 'overflow-hidden' : 'lg:overflow-y-auto',
        desktopContentTab === 'files' ? 'mt-2 lg:mt-0' : ''
      )}>
        {/* Content Area */}
        <div
          className={cn(
            'w-full flex-1 min-h-0 flex flex-col',
            desktopContentTab === 'files'
              ? 'h-full'
              : 'px-4 sm:px-6 lg:px-8 py-4 sm:py-8'
          )}
        >
          {/* Content Area */}
          {desktopContentTab === 'files' ? (
            <div className="flex-1 min-h-0 max-lg:flex-none flex flex-col gap-2 lg:flex-row lg:gap-1">
            {/* Mobile: natural-height column so the page scrolls through content +
                activity, instead of cramming both into one viewport (the activity
                panel's fixed 420px was crushing the files browser to a sliver). */}
            <div className="flex-1 min-w-0 min-h-0 max-lg:flex-none max-lg:h-[70dvh] flex flex-col">
            <ShareFilesBrowser
              groups={downloadableFilesWithOptimisticUploads}
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
                  window.dispatchEvent(new CustomEvent('seekToTime', { detail: { timestamp: 0, videoId: file.videoId, videoVersion: null, autoPlay: true } }))
                }, 0)
              }}
              onDownloadFiles={handleDownloadFiles}
              sharedDownloadProgress={downloadTransferSummary}
              isSharedDownloadActive={hasActiveDownloadTransfers}
              requestedOpenFolderName={requestedFilesFolderName}
              requestedOpenFileKey={requestedFilesFileKey}
              onOpenFileKeyHandled={() => setRequestedFilesFileKey(null)}
              onOpenFolderNameChange={handleFilesFolderChange}
              folderPreviewByName={folderPreviewByName}
              resolveFilePreviewUrl={resolveDownloadablePreviewUrl}
              resolveFilePlaybackUrl={resolveDownloadablePlaybackUrl}
              onPreviewTokenExpired={() => requestFilesRefresh(true)}
              onApproveVideo={handleApproveVideo}
              shareSlug={token}
              shareToken={shareToken}
              transferItems={transferItemsCombined}
              canUploadToProjects={Boolean(isAdminSession || (isAuthenticated && project?.allowClientUploadFiles && project?.enableClientUploads !== false))}
              canDeleteUploads={false}
              onCreateUploadFolder={handleCreateUploadFolder}
              onUploadFiles={handleUploadFiles}
              onDeleteUploadFile={undefined}
              onDeleteUploadFolder={undefined}
              onRenameUploadFolder={undefined}
            />
            </div>
            <div
              ref={activityPanelResize.containerRef}
              className="relative shrink-0 flex flex-col min-h-0 max-lg:h-[420px] lg:w-[420px]"
              style={activityPanelResize.isDesktop ? { width: Math.round(activityPanelResize.width) } : undefined}
            >
              <div
                onMouseDown={activityPanelResize.startResize}
                className="hidden lg:flex lg:items-center lg:justify-center absolute left-0 top-0 bottom-0 w-[5px] bg-transparent hover:bg-primary/15 cursor-col-resize select-none z-10 group transition-colors"
              >
                <div className="h-8 w-0.5 rounded-full bg-primary/45 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <ProjectActivityPanel
                fetchUrl={`/api/share/${token}/activity-feed`}
                authToken={!isAdminSession ? shareToken : null}
                onOpenTarget={handleOpenActivityTarget}
              />
            </div>
            </div>
          ) : activeAlbumId ? (
            <div className="flex-1 min-h-0 max-lg:flex-none flex flex-col gap-2 lg:flex-row lg:gap-1">
            {/* Mobile: natural-height column so the page scrolls through content +
                activity, instead of cramming both into one viewport (the activity
                panel's fixed 420px was crushing the files browser to a sliver). */}
            <div className="flex-1 min-w-0 min-h-0 max-lg:flex-none max-lg:h-[70dvh] flex flex-col">
            <ShareAlbumViewer
              shareSlug={token}
              shareToken={shareToken}
              albumId={activeAlbumId}
            />
            </div>
            <div
              ref={activityPanelResize.containerRef}
              className="relative shrink-0 flex flex-col min-h-0 max-lg:h-[420px] lg:w-[420px]"
              style={activityPanelResize.isDesktop ? { width: Math.round(activityPanelResize.width) } : undefined}
            >
              <div
                onMouseDown={activityPanelResize.startResize}
                className="hidden lg:flex lg:items-center lg:justify-center absolute left-0 top-0 bottom-0 w-[5px] bg-transparent hover:bg-primary/15 cursor-col-resize select-none z-10 group transition-colors"
              >
                <div className="h-8 w-0.5 rounded-full bg-primary/45 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <ProjectActivityPanel
                fetchUrl={`/api/share/${token}/activity-feed`}
                authToken={!isAdminSession ? shareToken : null}
                onOpenTarget={handleOpenActivityTarget}
              />
            </div>
            </div>
          ) : project.enableVideos === false ? (
            <Card className="bg-card border-border">
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">Select an album to view photos.</p>
              </CardContent>
            </Card>
          ) : readyVideos.length === 0 ? (
            <Card className="bg-card border-border flex-1 flex">
            </Card>
          ) : (
            <div
              className={`flex-1 min-h-0 ${project.hideFeedback
                ? 'flex flex-col w-full'
                : 'flex flex-col lg:flex-row gap-4 sm:gap-6 lg:-mx-8 lg:-my-8'}`}
            >
              {project.hideFeedback ? (
                <div className="flex-1 min-h-0 flex flex-col">
                  <VideoPlayer
                    videos={readyVideos}
                    projectId={project.id}
                    projectStatus={project.status}
                    defaultQuality={defaultQuality}
                    projectTitle={project.title}
                    clientName={project.clientName}
                    isPasswordProtected={isPasswordProtected || false}
                    activeVideoName={activeVideoName}
                    onApprove={fetchProjectData}
                    initialSeekTime={initialSeekTime}
                    initialVideoIndex={initialVideoIndex}
                    isAdmin={false}
                    isGuest={false}
                    shareToken={shareToken}
                    onStreamError={handleVideoStreamError}
                    commentsForTimeline={filteredComments}
                    hideDownloadButton={true}
                    useFullTimecode={Boolean(project?.useFullTimecode)}
                    showTimeDisplayToggle={true}
                    onCloseVideo={() => setDesktopContentTab('files')}
                    fillContainer
                  />
                  {/* Video name + Company logo row — below video player on mobile */}
                  {(activeVideoName || hasLogo) && (
                    <div className="flex items-center justify-between py-2 lg:hidden">
                      {activeVideoName ? (
                        <p className="text-sm font-medium text-foreground truncate mr-3">{activeVideoName}</p>
                      ) : <span />}
                      {hasLogo ? (
                        mainCompanyDomain ? (
                          <a href={mainCompanyDomain} target="_blank" rel="noopener noreferrer" className="block max-w-[100px] shrink-0 opacity-80 hover:opacity-100 transition-opacity">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={logoSrc} alt="Company logo" className="w-full max-h-10 h-auto object-contain" />
                          </a>
                        ) : (
                          <div className="max-w-[100px] shrink-0 opacity-80">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={logoSrc} alt="Company logo" className="w-full max-h-10 h-auto object-contain" />
                          </div>
                        )
                      ) : null}
                    </div>
                  )}
                </div>
              ) : (
                <ShareFeedbackGrid
                  project={project}
                  readyVideos={readyVideos}
                  filteredComments={filteredComments}
                  defaultQuality={defaultQuality}
                  activeVideoName={activeVideoName}
                  initialSeekTime={initialSeekTime}
                  initialVideoIndex={initialVideoIndex}
                  isPasswordProtected={isPasswordProtected || false}
                  shareSlug={token}
                  shareToken={shareToken}
                  otpSessionEmail={otpSessionEmail}
                  companyName={companyName}
                  hasLogo={hasLogo}
                  mainCompanyDomain={mainCompanyDomain}
                  onDraftGuardChange={(guard) => {
                    draftGuardRef.current = guard
                  }}
                  subtitleGuardRef={subtitleGuardRef}
                  onApprove={fetchProjectData}
                  onCloseVideo={() => setDesktopContentTab('files')}
                  onStreamError={handleVideoStreamError}
                  fetchContentToken={fetchVideoToken}
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

function ShareFeedbackGrid({
  project,
  readyVideos,
  filteredComments,
  defaultQuality,
  activeVideoName,
  initialSeekTime,
  initialVideoIndex,
  isPasswordProtected,
  shareSlug,
  shareToken,
  otpSessionEmail,
  companyName,
  hasLogo,
  mainCompanyDomain,
  onDraftGuardChange,
  subtitleGuardRef,
  onApprove,
  onCloseVideo,
  onStreamError,
  fetchContentToken,
}: {
  project: any
  readyVideos: any[]
  filteredComments: any[]
  defaultQuality: any
  activeVideoName: string
  initialSeekTime: number | null
  initialVideoIndex: number
  isPasswordProtected: boolean
  shareSlug: string
  shareToken: string | null
  otpSessionEmail: string | null
  companyName: string
  hasLogo: boolean
  mainCompanyDomain: string | null
  onDraftGuardChange?: (guard: DraftNavigationGuard | null) => void
  // Owned by the page (so its navigation guard can read it); the grid populates it.
  subtitleGuardRef: { current: (() => boolean) | null }
  onApprove: () => void
  onCloseVideo?: () => void
  onStreamError?: (videoId: string) => void
  fetchContentToken: (videoId: string, quality: string) => Promise<string | null>
}) {
  const logoSrc = '/api/branding/logo'
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

    // Safari < 14 uses addListener/removeListener
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
      if (!projectId || !shareToken) return
      const response = await fetch(`/api/comments?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${shareToken}` },
      })
      if (!response.ok) return
      const fresh = await response.json()
      setServerComments(fresh)
    } catch {
      // ignore
    }
  }, [projectId, shareToken])

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

  // Share the user's time-display preference so that CommentSectionView and
  // CommentInput stay in sync with the VideoPlayer toggle.
  const { timeDisplayMode } = useTimeDisplayMode(Boolean(project?.useFullTimecode))
  const effectiveUseFullTimecode = timeDisplayMode === 'timecode'

  const management = useCommentManagement({
    projectId: String(project.id),
    initialComments: serverComments as any,
    videos: readyVideos as any,
    // Use the OTP-authenticated email as the comment author email when available.
    clientEmail: otpSessionEmail || project.clientEmail,
    isPasswordProtected: Boolean(isPasswordProtected),
    adminUser: null,
    recipients: (project.recipients || []) as any,
    clientName: project.clientName,
    restrictToLatestVersion: Boolean(project.restrictCommentsToLatestVersion),
    shareToken,
    useAdminAuth: false,
    companyName,
    allowClientDeleteComments: Boolean(project.allowClientDeleteComments),
    allowClientUploadFiles: Boolean(project.allowClientUploadFiles),
  })

  const { authorName, setAuthorName } = management

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

  // Auto-select client display name based on OTP email matching a project recipient.
  // Only runs if the user hasn't already chosen a name.
  useEffect(() => {
    if (!isPasswordProtected) return
    if (!project?.recipients || !Array.isArray(project.recipients)) return
    if (authorName.trim()) return

    if (!otpSessionEmail) return

    const normalizedEmail = otpSessionEmail.toLowerCase().trim()
    if (!normalizedEmail) return

    const match = (project.recipients as any[]).find((r) => {
      const rEmail = String(r?.email || '').toLowerCase().trim()
      return rEmail && rEmail === normalizedEmail
    })

    if (!match) return

    const nextName = String(match?.name || '').trim() || normalizedEmail
    if (!nextName) return
    setAuthorName(nextName)
  }, [isPasswordProtected, project?.recipients, authorName, setAuthorName, otpSessionEmail])

  const isApproved = project.status === 'APPROVED'

  const latestVideoVersion = readyVideos.length > 0
    ? Math.max(...readyVideos.map((v: any) => v.version))
    : null

  const selectedVideo = readyVideos.find((v: any) => v.id === management.selectedVideoId)

  // Subtitle edit mode: swaps the comments panel for the subtitle editor and
  // (desktop) shows the timeline strip under the player. Entered from the
  // player's CC menu → Edit.
  const [isEditingSubtitles, setIsEditingSubtitles] = useState(false)
  const subtitleEditor = useSubtitleEditor({
    videoId: selectedVideo?.id ?? null,
    projectId: project?.id ?? null,
    videoName: String(selectedVideo?.name ?? 'Video'),
    versionLabel: String(selectedVideo?.versionLabel ?? ''),
    videoDurationSec: typeof selectedVideo?.duration === 'number' ? selectedVideo.duration : 0,
    shareToken,
    isAdmin: false,
    active: isEditingSubtitles,
    hasWaveform: Boolean(selectedVideo?.hasWaveformPeaks),
    fetchContentToken,
    onExit: () => setIsEditingSubtitles(false),
  })
  const subtitleGuard = subtitleEditor.guard
  useEffect(() => {
    subtitleGuardRef.current = isEditingSubtitles ? subtitleGuard : null
    return () => { subtitleGuardRef.current = null }
  }, [isEditingSubtitles, subtitleGuard, subtitleGuardRef])
  const selectedVideoApproved = selectedVideo ? Boolean(selectedVideo.approved) : false
  const anyApproved = readyVideos.some((v: any) => Boolean(v.approved))
  const commentsDisabled = Boolean(isApproved || selectedVideoApproved || anyApproved)

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
      <div ref={feedbackContainerRef} className="flex flex-col lg:flex-row lg:flex-1 lg:min-h-0 gap-4 sm:gap-6 lg:gap-0 lg:overflow-hidden">
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
              isPasswordProtected={isPasswordProtected}
              activeVideoName={activeVideoName}
              onApprove={onApprove}
              initialSeekTime={initialSeekTime}
              initialVideoIndex={initialVideoIndex}
              isAdmin={false}
              isGuest={false}
              shareToken={shareToken}
              onStreamError={onStreamError}
              commentsForTimeline={management.comments as any}
              disableFullscreenCommentsUI={commentsDisabled}
              useFullTimecode={Boolean(project?.useFullTimecode)}
              showTimeDisplayToggle={true}
              onCloseVideo={onCloseVideo}
              fillContainer
              pinControlsToBottom={false}
              onEnterSubtitleEditMode={() => {
                if (isEditingSubtitles) subtitleEditor.confirmAndExit()
                else setIsEditingSubtitles(true)
              }}
              isEditingSubtitles={isEditingSubtitles}
              videoSwitchGuardRef={subtitleGuardRef}
            />
          </div>

          {isEditingSubtitles && isDesktop && (
            <div className="shrink-0">
              <SubtitleTimelineStrip editor={subtitleEditor} />
            </div>
          )}

          {!commentsDisabled && !isEditingSubtitles ? (
            <div className="mt-3 lg:hidden">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                shareSlug={shareSlug}
                shareToken={shareToken}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                onFileSelect={management.onFileSelect}
                attachedFiles={management.attachedFiles}
                onRemoveFile={management.onRemoveFile}
                voiceNoteDraft={management.voiceNoteDraft}
                onVoiceNoteSelect={management.onVoiceNoteSelect}
                onVoiceNoteClear={management.onVoiceNoteClear}
                allowFileUpload={Boolean(project.allowClientUploadFiles)}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                selectedEndTimestamp={management.selectedEndTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                onClearRange={management.handleClearRange}
                onSetTimes={management.handleSetCommentTimes}
                videoDurationSeconds={typeof selectedVideo?.duration === 'number' ? selectedVideo.duration : undefined}
                showTimestampReset={management.shouldShowTimestampReset}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={effectiveUseFullTimecode}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={Boolean(isPasswordProtected)}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipientId={management.recipientId}
                onRecipientSelect={(name, id) => management.setRecipient(name, id)}
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
            'relative lg:sticky lg:top-0 lg:self-stretch lg:h-[calc(100dvh-var(--admin-header-height,0px))] lg:min-h-0 lg:overflow-hidden lg:shrink-0',
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
            {isEditingSubtitles ? (
              <div className="lg:flex-1 max-lg:flex-none max-lg:h-[70dvh] min-h-0 border border-border rounded-lg bg-card">
                <SubtitleEditPanel editor={subtitleEditor} />
              </div>
            ) : (
            <CommentSectionView
              projectId={project.id}
              projectSlug={shareSlug}
              comments={serverComments as any}
              clientName={project.clientName}
              clientEmail={project.clientEmail}
              isApproved={isApproved}
              restrictToLatestVersion={Boolean(project.restrictCommentsToLatestVersion)}
              useFullTimecode={effectiveUseFullTimecode}
              videos={readyVideos as any}
              isAdminView={false}
              companyName={companyName}
              clientCompanyName={project.companyName}
              smtpConfigured={project.smtpConfigured}
              isPasswordProtected={isPasswordProtected}
              recipients={project.recipients || []}
              shareToken={shareToken}
              showShortcutsButton={isDesktop}
              allowClientDeleteComments={project.allowClientDeleteComments}
              allowClientUploadFiles={project.allowClientUploadFiles}
              allowCommentFileUpload={Boolean(project.allowClientUploadFiles)}
              hideInput={true}
              largeAvatars={true}
              cardClassName={!commentsDisabled && isDesktop ? 'rounded-b-none' : undefined}
              management={management as any}
            />
            )}
          </div>

          {!commentsDisabled && !isEditingSubtitles ? (
            <div className="hidden lg:block shrink-0">
              <CommentInput
                newComment={management.newComment}
                onCommentChange={management.handleCommentChange}
                onSubmit={management.handleSubmitComment}
                loading={management.loading}
                shareSlug={shareSlug}
                shareToken={shareToken}
                uploadProgress={management.uploadProgress}
                uploadStatusText={management.uploadStatusText}
                onFileSelect={management.onFileSelect}
                attachedFiles={management.attachedFiles}
                onRemoveFile={management.onRemoveFile}
                voiceNoteDraft={management.voiceNoteDraft}
                onVoiceNoteSelect={management.onVoiceNoteSelect}
                onVoiceNoteClear={management.onVoiceNoteClear}
                allowFileUpload={Boolean(project.allowClientUploadFiles)}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                selectedEndTimestamp={management.selectedEndTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                onClearRange={management.handleClearRange}
                onSetTimes={management.handleSetCommentTimes}
                videoDurationSeconds={typeof selectedVideo?.duration === 'number' ? selectedVideo.duration : undefined}
                showTimestampReset={management.shouldShowTimestampReset}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={effectiveUseFullTimecode}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={Boolean(isPasswordProtected)}
                authorName={management.authorName}
                onAuthorNameChange={management.setAuthorName}
                recipientId={management.recipientId}
                onRecipientSelect={(name, id) => management.setRecipient(name, id)}
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

      {/* Mobile logo at the bottom of the page */}
      {hasLogo && (
        <div className="lg:hidden py-6 px-8 flex justify-center">
          {mainCompanyDomain ? (
            <a href={mainCompanyDomain} target="_blank" rel="noopener noreferrer" className="block max-w-[200px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoSrc} alt="Company logo" className="w-full max-h-16 h-auto object-contain" />
            </a>
          ) : (
            <div className="max-w-[200px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logoSrc} alt="Company logo" className="w-full max-h-16 h-auto object-contain" />
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Blocking first-login prompt for password-authenticated clients: they must pick a
 * project recipient or type a name before they can use the page. The chosen name is
 * persisted (by the caller) into the same slot the comment name picker reads, so all
 * attribution — comments, uploads, approvals — is consistent.
 */
function ShareNameCaptureModal({
  recipients,
  onConfirm,
}: {
  recipients: Array<{ id: string; name?: string | null }>
  onConfirm: (name: string, recipientId: string | null) => void
}) {
  const namedRecipients = recipients.filter((r) => String(r?.name || '').trim())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [customName, setCustomName] = useState('')
  // Confirm may register the typed name as a recipient (async) — block re-clicks
  // while that's in flight; the modal unmounts once the caller flips the state.
  const [submitting, setSubmitting] = useState(false)

  const canConfirm = !submitting && (selectedId ? true : customName.trim().length > 0)

  const handleConfirm = () => {
    if (submitting) return
    if (selectedId) {
      const recipient = namedRecipients.find((r) => r.id === selectedId)
      setSubmitting(true)
      onConfirm(String(recipient?.name || '').trim(), selectedId)
    } else if (customName.trim()) {
      setSubmitting(true)
      onConfirm(customName.trim(), null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <Card className="bg-card border-border w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome — who are you?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Please choose or enter your name so we can attribute your comments, uploads and approvals.
          </p>

          {namedRecipients.length > 0 && (
            <div className="space-y-2">
              {namedRecipients.map((recipient) => (
                <button
                  key={recipient.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(recipient.id)
                    setCustomName('')
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-lg border transition-colors',
                    selectedId === recipient.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:bg-muted text-foreground',
                  )}
                >
                  {recipient.name}
                </button>
              ))}
              <p className="text-xs text-muted-foreground pt-1">Or enter a different name:</p>
            </div>
          )}

          <Input
            value={customName}
            onChange={(e) => {
              setCustomName(e.target.value)
              setSelectedId(null)
            }}
            placeholder="Your name"
            maxLength={30}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canConfirm) handleConfirm()
            }}
          />

          <Button type="button" className="w-full" disabled={!canConfirm} onClick={handleConfirm}>
            Continue
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
