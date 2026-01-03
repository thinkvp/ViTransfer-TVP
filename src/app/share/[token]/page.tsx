'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import VideoPlayer from '@/components/VideoPlayer'
import CommentInput from '@/components/CommentInput'
import { CommentSectionView } from '@/components/CommentSection'
import { GripVertical } from 'lucide-react'
import VideoSidebar from '@/components/VideoSidebar'
import { OTPInput } from '@/components/OTPInput'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { Button } from '@/components/ui/button'
import { Lock, Check, Mail, KeyRound } from 'lucide-react'
import { loadShareToken, saveShareToken } from '@/lib/share-token-store'
import { useCommentManagement } from '@/hooks/useCommentManagement'
import { cn } from '@/lib/utils'

export default function SharePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const token = params?.token as string

  // Parse URL parameters for video seeking
  const urlTimestamp = searchParams?.get('t') ? parseInt(searchParams.get('t')!, 10) : null
  const urlVideoName = searchParams?.get('video') || null
  const urlVersion = searchParams?.get('version') ? parseInt(searchParams.get('version')!, 10) : null

  const [isPasswordProtected, setIsPasswordProtected] = useState<boolean | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isGuest, setIsGuest] = useState(false)
  const [authMode, setAuthMode] = useState<string>('PASSWORD')
  const [guestMode, setGuestMode] = useState(false)
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [error, setError] = useState('')
  const [project, setProject] = useState<any>(null)
  const [comments, setComments] = useState<any[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [companyName, setCompanyName] = useState('Studio')
  const [defaultQuality, setDefaultQuality] = useState<'720p' | '1080p'>('720p')
  const [activeVideoName, setActiveVideoName] = useState<string>('')
  const [activeVideos, setActiveVideos] = useState<any[]>([])
  const [activeVideosRaw, setActiveVideosRaw] = useState<any[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  const [initialSeekTime, setInitialSeekTime] = useState<number | null>(null)
  const [initialVideoIndex, setInitialVideoIndex] = useState<number>(0)
  const [shareToken, setShareToken] = useState<string | null>(null)
  const storageKey = token || ''
  const tokenCacheRef = useRef<Map<string, any>>(new Map())

  // Load stored token once (persist across refresh)
  useEffect(() => {
    if (!storageKey) return
    const stored = loadShareToken(storageKey)
    if (stored) {
      setShareToken(stored)
    }
  }, [storageKey])


  // Fetch comments separately for security
  const fetchComments = async () => {
    if (!token || !shareToken) return

    setCommentsLoading(true)
    try {
      const response = await fetch(`/api/share/${token}/comments`, {
        headers: {
          Authorization: `Bearer ${shareToken}`
        }
      })
      if (response.ok) {
        const commentsData = await response.json()
        setComments(commentsData)
      }
    } catch (error) {
      // Failed to load comments
    } finally {
      setCommentsLoading(false)
    }
  }

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
  }, [token, shareToken])

  // Fetch project data function (for refresh after approval)
  const fetchProjectData = async (tokenOverride?: string | null) => {
    try {
      const authToken = tokenOverride || shareToken
      const projectResponse = await fetch(`/api/share/${token}`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      })
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

        // Clear token cache to force re-fetch of video tokens with updated approval status
        tokenCacheRef.current.clear()

        // Fetch comments after project loads (if not hidden)
        if (!projectData.hideFeedback) {
          fetchComments()
        }
      }
    } catch (error) {
      // Failed to load project data
    }
  }

  // When a client approves a video from the comment panel, refresh project/videos so UI updates without a full reload.
  useEffect(() => {
    const handleApprovalChanged = () => {
      fetchProjectData()
    }

    window.addEventListener('videoApprovalChanged', handleApprovalChanged)
    return () => {
      window.removeEventListener('videoApprovalChanged', handleApprovalChanged)
    }
    // Intentionally omit fetchProjectData from deps; it's stable enough for this usage and avoids re-binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Company name and default quality now loaded from project settings
  // This ensures they're only accessible after authentication

  // Load project data (handles auth check implicitly via API response)
  useEffect(() => {
    let isMounted = true

    async function loadProject() {
      try {
        const response = await fetch(`/api/share/${token}`, {
          headers: shareToken ? { Authorization: `Bearer ${shareToken}` } : undefined
        })

        if (!isMounted) return

        if (response.status === 401) {
          saveShareToken(storageKey, null)
          const data = await response.json()
          if (data.authMode === 'NONE' && data.guestMode) {
            try {
              const guestResponse = await fetch(`/api/share/${token}/guest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              })
              if (guestResponse.ok) {
                const guestData = await guestResponse.json()
                if (guestData.shareToken) {
                  setShareToken(guestData.shareToken)
                  saveShareToken(storageKey, guestData.shareToken)
                  setIsGuest(true)
                  setIsAuthenticated(true)
                  await loadProject()
                  return
                }
              }
            } catch {
              // fall through
            }
          }

          setIsPasswordProtected(true)
          setIsAuthenticated(false)
          setAuthMode(data.authMode || 'PASSWORD')
          setGuestMode(data.guestMode || false)
          return
        }

        if (response.status === 403 || response.status === 404) {
          window.location.href = '/'
          return
        }

        if (response.ok) {
          const projectData = await response.json()
          if (projectData.shareToken) {
            setShareToken(projectData.shareToken)
            saveShareToken(storageKey, projectData.shareToken)
          }
          if (isMounted) {
            setProject(projectData)
            setIsPasswordProtected(!!projectData.recipients && projectData.recipients.length > 0)
            setIsAuthenticated(true)
            setIsGuest(projectData.isGuest || false)

            if (projectData.settings) {
              setCompanyName(projectData.settings.companyName || 'Studio')
              setDefaultQuality(projectData.settings.defaultPreviewResolution || '720p')
            }

            if (!projectData.hideFeedback) {
              fetchComments()
            }
          }
        }
      } catch (error) {
        // Silent fail
      }
    }

    loadProject()

    return () => {
      isMounted = false
    }
  }, [token, shareToken])

  // Set active video when project loads, handling URL parameters
  useEffect(() => {
    if (project?.videosByName) {
      const videoNames = Object.keys(project.videosByName)
      if (videoNames.length === 0) return

      // Determine which video group should be active
      if (!activeVideoName) {
        let videoNameToUse: string | null = null

        // Priority 1: URL parameter for video name
        if (urlVideoName && project.videosByName[urlVideoName]) {
          videoNameToUse = urlVideoName
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

        // Priority 3: First video
        if (!videoNameToUse) {
          videoNameToUse = videoNames[0]
        }

        setActiveVideoName(videoNameToUse)

        const videos = project.videosByName[videoNameToUse]
        setActiveVideosRaw(videos)

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
      } else {
        // Keep activeVideos in sync when project data refreshes (ensures updated approval status/thumbnails/tokens)
        const videos = project.videosByName[activeVideoName]
        if (videos) {
          setActiveVideosRaw(videos)
        }
      }
    }
  }, [project?.videosByName, activeVideoName, urlVideoName, urlVersion, urlTimestamp])

  const fetchVideoToken = async (videoId: string, quality: string) => {
    if (!shareToken) return ''
    const response = await fetch(`/api/share/${token}/video-token?videoId=${videoId}&quality=${quality}`, {
      headers: {
        Authorization: `Bearer ${shareToken}`,
      }
    })
    if (!response.ok) return ''
    const data = await response.json()
    return data.token || ''
  }

  const fetchTokensForVideos = async (videos: any[]) => {
    if (!shareToken) return videos

    const shouldFetchTimelinePreviews = !!project?.timelinePreviewsEnabled

    return Promise.all(
      videos.map(async (video: any) => {
        const cached = tokenCacheRef.current.get(video.id)
        if (cached) {
          return cached
        }

        try {
          let streamToken720p = ''
          let streamToken1080p = ''
          let downloadToken = null

          if (video.approved) {
            const originalToken = await fetchVideoToken(video.id, 'original')
            streamToken720p = originalToken
            streamToken1080p = originalToken
            downloadToken = originalToken
          } else {
            const [token720, token1080] = await Promise.all([
              fetchVideoToken(video.id, '720p'),
              fetchVideoToken(video.id, '1080p'),
            ])
            streamToken720p = token720
            streamToken1080p = token1080
          }

          let thumbnailUrl = null
          if (video.hasThumbnail) {
            const thumbToken = await fetchVideoToken(video.id, 'thumbnail')
            if (thumbToken) {
              thumbnailUrl = `/api/content/${thumbToken}`
            }
          }

          let timelineVttUrl = null
          let timelineSpriteUrl = null
          if (shouldFetchTimelinePreviews && video.timelinePreviewsReady) {
            const [vttToken, spriteToken] = await Promise.all([
              fetchVideoToken(video.id, 'timeline-vtt'),
              fetchVideoToken(video.id, 'timeline-sprite'),
            ])
            timelineVttUrl = vttToken ? `/api/content/${vttToken}` : null
            timelineSpriteUrl = spriteToken ? `/api/content/${spriteToken}` : null
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
  }

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
  }, [activeVideosRaw, shareToken])

  // Handle video selection
  const handleVideoSelect = (videoName: string) => {
    setActiveVideoName(videoName)
    setActiveVideosRaw(project.videosByName[videoName])
  }

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
        setIsAuthenticated(true)
        setIsGuest(false)

        await fetchProjectData(data.shareToken)
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
        setIsAuthenticated(true)
        setIsGuest(false)

        await fetchProjectData(data.shareToken)
      } else {
        setError('Incorrect password')
      }
    } catch (error) {
      setError('An error occurred')
    } finally {
      setLoading(false)
    }
  }

  async function handleGuestEntry() {
    setLoading(true)
    setError('')

    try {
      const response = await fetch(`/api/share/${token}/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (response.ok) {
        const data = await response.json()
        if (data.shareToken) {
          setShareToken(data.shareToken)
          saveShareToken(storageKey, data.shareToken)
        }
        setIsAuthenticated(true)
        setIsGuest(true)

        await fetchProjectData(data.shareToken)
      } else {
        setError('Unable to access as guest')
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
              <Lock className="w-12 h-12 text-muted-foreground" />
            </div>
            <CardTitle className="text-foreground">Authentication Required</CardTitle>
            <p className="text-muted-foreground text-sm mt-2">
              {authMode === 'PASSWORD' && 'Please enter the password to continue.'}
              {authMode === 'OTP' && 'Enter your email to receive an access code.'}
              {authMode === 'BOTH' && 'Choose your preferred authentication method.'}
            </p>
            <p className="text-xs text-muted-foreground mt-3 px-4">
              This authentication is for those assigned to this project.
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

            {/* Guest Entry Button - hide when OTP code is being entered */}
            {guestMode && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border"></div>
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">Not assigned to this project?</span>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground text-center">
                  Guest users do not have permissions to provide feedback, approve videos, or download files.
                </p>
                <Button
                  type="button"
                  size="default"
                  onClick={handleGuestEntry}
                  disabled={loading}
                  className="w-full bg-warning text-white hover:bg-warning/90 shadow-elevation hover:shadow-elevation-lg hover:-translate-y-0.5 active:translate-y-0 active:shadow-elevation transition-all duration-200"
                >
                  Continue as Guest
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    )
  }

  // Show project not found
  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center p-4">
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Project not found</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Filter to READY videos first
  let readyVideos = activeVideos.filter((v: any) => v.status === 'READY')

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

  return (
    <div className="flex-1 min-h-0 bg-background flex flex-col lg:flex-row overflow-hidden">
      {/* Video Sidebar - contains both desktop and mobile versions internally */}
      {project.videosByName && (
        <VideoSidebar
          videosByName={project.videosByName}
          activeVideoName={activeVideoName}
          onVideoSelect={handleVideoSelect}
          className="w-64 flex-shrink-0"
        />
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Content Area */}
        <div className="w-full px-4 sm:px-6 lg:px-8 py-4 sm:py-8 flex-1 min-h-0 flex flex-col">
          {/* Content Area */}
          {readyVideos.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  {tokensLoading ? 'Loading video...' : 'No videos are ready for review yet. Please check back later.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div
              className={`flex-1 min-h-0 ${(project.hideFeedback || isGuest)
                ? 'flex flex-col max-w-7xl mx-auto w-full'
                : 'flex flex-col lg:flex-row gap-4 sm:gap-6 lg:-mx-8 lg:-my-8'}`}
            >
              {(project.hideFeedback || isGuest) ? (
                <div className="flex-1 min-h-0 flex flex-col">
                  <VideoPlayer
                    videos={readyVideos}
                    projectId={project.id}
                    projectStatus={project.status}
                    defaultQuality={defaultQuality}
                    projectTitle={project.title}
                    projectDescription={isGuest ? null : project.description}
                    clientName={isGuest ? null : project.clientName}
                    isPasswordProtected={isPasswordProtected || false}
                    watermarkEnabled={project.watermarkEnabled}
                    activeVideoName={activeVideoName}
                    onApprove={isGuest ? undefined : fetchProjectData}
                    initialSeekTime={initialSeekTime}
                    initialVideoIndex={initialVideoIndex}
                    isAdmin={false}
                    isGuest={isGuest}
                    shareToken={shareToken}
                    commentsForTimeline={filteredComments}
                  />
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
                  shareToken={shareToken}
                  companyName={companyName}
                  onApprove={fetchProjectData}
                />
              )}

            </div>
          )}
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
  shareToken,
  companyName,
  onApprove,
}: {
  project: any
  readyVideos: any[]
  filteredComments: any[]
  defaultQuality: any
  activeVideoName: string
  initialSeekTime: number | null
  initialVideoIndex: number
  isPasswordProtected: boolean
  shareToken: string | null
  companyName: string
  onApprove: () => void
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

    // Safari < 14 uses addListener/removeListener
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
  // to whatever is required to avoid clipping (prevents the move button from being pushed off-screen).
  useEffect(() => {
    if (!isDesktop || !commentInputInRightColumn) return

    const raf = window.requestAnimationFrame(() => {
      const el = commentInputMeasureRef.current
      if (!el) return

      const available = Math.round(el.clientWidth)
      const needed = Math.round(el.scrollWidth)

      if (Number.isFinite(available) && Number.isFinite(needed) && needed > available + 1) {
        setCommentInputMinWidth((prev) => Math.max(prev ?? 320, needed))
      }
    })

    return () => window.cancelAnimationFrame(raf)
  }, [isDesktop, commentInputInRightColumn, commentsWidth])

  useEffect(() => {
    if (!isDesktop) return
    const onResize = () => {
      setCommentInputMinWidth(null)
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
      if (Number.isFinite(width) && width >= 320 && width <= window.innerWidth * 0.6) {
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
      const minWidth = commentInputInRightColumn && commentInputMinWidth ? commentInputMinWidth : 320
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

  const management = useCommentManagement({
    projectId: String(project.id),
    initialComments: serverComments as any,
    videos: readyVideos as any,
    clientEmail: project.clientEmail,
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

  const isApproved = project.status === 'APPROVED' || project.status === 'SHARE_ONLY'

  const latestVideoVersion = readyVideos.length > 0
    ? Math.max(...readyVideos.map((v: any) => v.version))
    : null

  const selectedVideo = readyVideos.find((v: any) => v.id === management.selectedVideoId)
  const selectedVideoApproved = selectedVideo ? Boolean(selectedVideo.approved) : false
  const anyApproved = readyVideos.some((v: any) => Boolean(v.approved))
  const commentsDisabled = Boolean(isApproved || selectedVideoApproved || anyApproved)

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
      <div ref={feedbackContainerRef} className="flex flex-col lg:flex-row flex-1 min-h-0 gap-4 sm:gap-6 lg:gap-0">
        <div
          ref={leftPaneRef}
          className="flex-1 min-h-0 min-w-0 flex flex-col lg:pl-8 lg:pr-8 lg:py-8 lg:overflow-hidden lg:h-[calc(100dvh-var(--admin-header-height))]"
        >
          <div
            className="flex-1 min-h-0 overflow-hidden"
          >
            <VideoPlayer
              videos={readyVideos}
              projectId={project.id}
              projectStatus={project.status}
              defaultQuality={defaultQuality}
              projectTitle={project.title}
              projectDescription={project.description}
              clientName={project.clientName}
              isPasswordProtected={isPasswordProtected}
              watermarkEnabled={project.watermarkEnabled}
              activeVideoName={activeVideoName}
              onApprove={onApprove}
              initialSeekTime={initialSeekTime}
              initialVideoIndex={initialVideoIndex}
              isAdmin={false}
              isGuest={false}
              shareToken={shareToken}
              commentsForTimeline={management.comments as any}
              fitToContainerHeight={isDesktop}
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
                onFileSelect={management.onFileSelect}
                attachedFiles={management.attachedFiles}
                onRemoveFile={management.onRemoveFile}
                allowFileUpload={Boolean(project.allowClientUploadFiles)}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={Boolean(project?.useFullTimecode)}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={Boolean(isPasswordProtected)}
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
            'relative lg:sticky lg:top-0 lg:self-stretch lg:h-[calc(100dvh-var(--admin-header-height))] min-h-0 overflow-hidden flex-shrink-0',
            'lg:flex lg:flex-col'
          )}
          style={
            isDesktop
              ? {
                  width: `${Math.round(commentsWidth)}px`,
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
              comments={serverComments as any}
              clientName={project.clientName}
              clientEmail={project.clientEmail}
              isApproved={isApproved}
              restrictToLatestVersion={Boolean(project.restrictCommentsToLatestVersion)}
              useFullTimecode={Boolean(project?.useFullTimecode)}
              videos={readyVideos as any}
              isAdminView={false}
              companyName={companyName}
              clientCompanyName={project.companyName}
              smtpConfigured={project.smtpConfigured}
              isPasswordProtected={isPasswordProtected}
              recipients={project.recipients || []}
              shareToken={shareToken}
              showShortcutsButton={true}
              allowClientDeleteComments={project.allowClientDeleteComments}
              allowClientUploadFiles={project.allowClientUploadFiles}
              hideInput={true}
              showThemeToggle={true}
              management={management as any}
            />
          </div>

          {commentInputInRightColumn ? (
            <div ref={commentInputMeasureRef} className="mt-4 flex-shrink-0">
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
                allowFileUpload={Boolean(project.allowClientUploadFiles)}
                clientUploadQuota={management.clientUploadQuota}
                onRefreshUploadQuota={management.refreshClientUploadQuota}
                selectedTimestamp={management.selectedTimestamp}
                onClearTimestamp={management.handleClearTimestamp}
                selectedVideoFps={management.selectedVideoFps}
                useFullTimecode={Boolean(project?.useFullTimecode)}
                replyingToComment={management.replyingToComment}
                onCancelReply={management.handleCancelReply}
                showAuthorInput={Boolean(isPasswordProtected)}
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
