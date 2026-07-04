'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { PasswordInput } from '@/components/ui/password-input'
import { ScheduleSelector } from '@/components/ScheduleSelector'
import { SharePasswordRequirements } from '@/components/SharePasswordRequirements'
import { apiFetch } from '@/lib/api-client'
import { sanitizeSlug } from '@/lib/utils'
import { apiPatch, apiPost } from '@/lib/api-client'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, FolderSync, Save, RefreshCw, Copy, Check, ChevronDown, ChevronUp, FileText, Bell, Video, MessageSquare, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { canDoAction, normalizeRolePermissions } from '@/lib/rbac'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

// Client-safe password generation using Web Crypto API
function generateSecurePassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const numbers = '23456789'
  const special = '!@#$%'
  const all = letters + numbers + special

  const getRandomInt = (max: number) => {
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    return array[0] % max
  }

  let password = ''
  password += letters.charAt(getRandomInt(letters.length))
  password += numbers.charAt(getRandomInt(numbers.length))

  for (let i = 2; i < 12; i++) {
    password += all.charAt(getRandomInt(all.length))
  }

  // Fisher-Yates shuffle
  const chars = password.split('')
  for (let i = chars.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }

  return chars.join('')
}

// Client-safe slug generation using Web Crypto API
function generateRandomSlug(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  const getRandomInt = (max: number) => {
    const array = new Uint32Array(1)
    crypto.getRandomValues(array)
    return array[0] % max
  }

  let slug = ''
  const length = 8 + getRandomInt(5) // 8-12 chars
  for (let i = 0; i < length; i++) {
    slug += chars.charAt(getRandomInt(chars.length))
    if (i > 0 && i < length - 1 && getRandomInt(5) === 0) {
      slug += '-'
    }
  }
  return slug.replace(/-+/g, '-')
}

interface Project {
  id: string
  title: string
  status: string
  slug: string
  description: string | null
  companyName: string | null
  clientId?: string | null
  enableVideos?: boolean
  enablePhotos?: boolean
  enableUploads?: boolean
  _count?: { videos: number; albums: number; shareUploadFiles: number }
  restrictCommentsToLatestVersion: boolean
  hideFeedback: boolean
  useFullTimecode: boolean
  allowClientDeleteComments: boolean
  allowClientUploadFiles: boolean
  allowAuthenticatedProjectSwitching: boolean
  maxClientUploadAllocationMB: number
  sharePassword: string | null
  sharePasswordDecrypted: string | null
  authMode: string
  globalAllowAuthenticatedProjectSwitching?: boolean
  previewResolutions: string
  clientNotificationSchedule: string
  clientNotificationTime: string | null
  clientNotificationDay: number | null
}

export default function ProjectSettingsPage() {
  const params = useParams()
  const router = useRouter()
  const projectId = params?.id as string

  const { user } = useAuth()
  const permissions = normalizeRolePermissions(user?.permissions)
  const canChangeProjectSettings = canDoAction(permissions, 'changeProjectSettings')

  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [copiedPassword, setCopiedPassword] = useState(false)

  // Form state
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [enableVideos, setEnableVideos] = useState(true)
  const [enablePhotos, setEnablePhotos] = useState(false)
  const [enableUploads, setEnableUploads] = useState(true)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [clientSuggestions, setClientSuggestions] = useState<Array<{ id: string; name: string }>>([])
  const clientSearchRef = useRef<HTMLDivElement>(null)
  const [clientsLoading, setClientsLoading] = useState(false)
  const [restrictCommentsToLatestVersion, setRestrictCommentsToLatestVersion] = useState(false)
  const [hideFeedback, setHideFeedback] = useState(false)
  const [useFullTimecode, setUseFullTimecode] = useState(false)
  const [allowClientDeleteComments, setAllowClientDeleteComments] = useState(false)
  const [enableClientUploads, setEnableClientUploads] = useState(true)
  const [allowClientUploadFiles, setAllowClientUploadFiles] = useState(false)
  const [allowAuthenticatedProjectSwitching, setAllowAuthenticatedProjectSwitching] = useState(true)
  const [maxClientUploadAllocationMB, setMaxClientUploadAllocationMB] = useState<number | ''>(1000)
  const [sharePassword, setSharePassword] = useState('')
  const [authMode, setAuthMode] = useState('PASSWORD')
  const [useCustomSlug, setUseCustomSlug] = useState(false) // Toggle for custom slug
  const [customSlugValue, setCustomSlugValue] = useState('') // Store custom slug value
  const [previewResolutions, setPreviewResolutions] = useState<string[]>(['720p'])

  // Notification settings state
  const [clientNotificationSchedule, setClientNotificationSchedule] = useState('HOURLY')
  const [clientNotificationTime, setClientNotificationTime] = useState('09:00')
  const [clientNotificationDay, setClientNotificationDay] = useState(1)

  // SMTP and recipients validation (for OTP)
  const [smtpConfigured, setSmtpConfigured] = useState(true)
  const [recipients, setRecipients] = useState<any[]>([])
  const hasRecipientWithEmail = recipients?.some((r: any) => r.email && r.email.trim() !== '') || false

  // Unsaved changes tracking
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const currentSnapshot = JSON.stringify({
    title, description, companyName, enableVideos, enablePhotos, enableUploads, selectedClientId,
    restrictCommentsToLatestVersion, hideFeedback,
    useFullTimecode, allowClientDeleteComments, allowClientUploadFiles,
    allowAuthenticatedProjectSwitching, maxClientUploadAllocationMB, sharePassword,
    authMode, useCustomSlug, customSlugValue,
    previewResolutions, clientNotificationSchedule, clientNotificationTime,
    clientNotificationDay,
  })
  const hasUnsavedChanges = savedSnapshot !== '' && currentSnapshot !== savedSnapshot
  useUnsavedChanges(hasUnsavedChanges)

  // Collapsible section state (all collapsed by default)
  const [showProjectDetails, setShowProjectDetails] = useState(false)
  const [showClientInfo, setShowClientInfo] = useState(false)
  const [showVideoProcessing, setShowVideoProcessing] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  // Active section for desktop two-column nav
  const [activeSection, setActiveSection] = useState('project-details')

  // Track original processing settings for change detection
  const [originalSettings, setOriginalSettings] = useState({
    title: '',
    previewResolutions: ['720p'] as string[],
  })

  // Reprocessing state
  const [reprocessing, setReprocessing] = useState(false)
  const isProjectClosed = project?.status === 'CLOSED'

  // S3 rename confirmation modal
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false)
  const [pendingRenameTitle, setPendingRenameTitle] = useState('')
  const [pendingRenameReprocess, setPendingRenameReprocess] = useState(false)
  const [pendingRenameUpdates, setPendingRenameUpdates] = useState<any>(null)
  const [renameSizeLoading, setRenameSizeLoading] = useState(false)
  const [renameSizeInfo, setRenameSizeInfo] = useState<{ totalObjects: number; totalBytes: string } | null>(null)
  const [renameConfirming, setRenameConfirming] = useState(false)

  // Auto-generate slug from title
  const autoGeneratedSlug = sanitizeSlug(title)

  // Use custom slug if enabled, otherwise use auto-generated
  const slug = useCustomSlug ? customSlugValue : autoGeneratedSlug

  // Sanitize slug for live preview
  const sanitizedSlug = sanitizeSlug(slug)

  const copyPassword = async () => {
    if (sharePassword) {
      await navigator.clipboard.writeText(sharePassword)
      setCopiedPassword(true)
      setTimeout(() => setCopiedPassword(false), 2000)
    }
  }

  useEffect(() => {
    async function loadProject() {
      try {
        const response = await apiFetch(`/api/projects/${projectId}`)
        if (!response.ok) {
          throw new Error('Failed to load project')
        }
        const data = await response.json()
        setProject(data)

        // Set SMTP status and recipients
        setSmtpConfigured(data.smtpConfigured !== false)
        setRecipients(data.recipients || [])

        // Set form values
        setTitle(data.title)
        setDescription(data.description || '')
        setCompanyName(data.companyName || '')
        setEnableVideos(data.enableVideos !== false)
        setEnablePhotos(data.enablePhotos === true)
        setEnableUploads(data.enableUploads !== false)
        setSelectedClientId(data.clientId || null)
        setRestrictCommentsToLatestVersion(data.restrictCommentsToLatestVersion)
        setHideFeedback(data.hideFeedback || false)
        setUseFullTimecode(data.useFullTimecode ?? false)
        setAllowClientDeleteComments(data.allowClientDeleteComments ?? false)
        setEnableClientUploads(data.enableClientUploads ?? true)
        setAllowClientUploadFiles(data.allowClientUploadFiles ?? false)
        setAllowAuthenticatedProjectSwitching(data.allowAuthenticatedProjectSwitching ?? true)
        setMaxClientUploadAllocationMB(data.maxClientUploadAllocationMB ?? 1000)
        setPreviewResolutions((() => {
          try {
            const parsed = JSON.parse(data.previewResolutions || '[]')
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['720p']
          } catch { return ['720p'] }
        })())
        setAuthMode(data.authMode || 'PASSWORD')
        setSharePassword(data.sharePassword || '')

        // Store original processing settings
        setOriginalSettings({
          title: data.title,
          previewResolutions: (() => {
            try {
              const parsed = JSON.parse(data.previewResolutions || '[]')
              return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['720p']
            } catch { return ['720p'] }
          })(),
        })

        // Check if slug was manually customized (different from auto-generated from title)
        const autoGeneratedSlug = sanitizeSlug(data.title)
        if (data.slug !== autoGeneratedSlug) {
          setUseCustomSlug(true)
          setCustomSlugValue(data.slug)
        }

        // Set notification settings
        setClientNotificationSchedule(data.clientNotificationSchedule || 'HOURLY')
        setClientNotificationTime(data.clientNotificationTime || '09:00')
        setClientNotificationDay(data.clientNotificationDay ?? 1)

        // Mark initial load as complete
        setInitialLoadComplete(true)
      } catch (err) {
        setError('Failed to load project settings')
      } finally {
        setLoading(false)
      }
    }

    loadProject()
  }, [projectId])

  // Set the saved snapshot once initial load populates all state
  // (effect is placed after the initialLoadComplete state declaration below)

  const loadClientSuggestions = useCallback(async (query: string) => {
    const q = query.trim()
    if (!q) {
      setClientSuggestions([])
      setClientsLoading(false)
      return
    }

    setClientsLoading(true)
    try {
      const res = await apiFetch(`/api/clients?query=${encodeURIComponent(q)}&active=active`)
      if (!res.ok) {
        setClientSuggestions([])
        return
      }
      const data = await res.json()
      setClientSuggestions(((data?.clients || []) as any[]).map((c) => ({ id: c.id, name: c.name })))
    } catch {
      setClientSuggestions([])
    } finally {
      setClientsLoading(false)
    }
  }, [])

  // Close client suggestions dropdown when clicking outside
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      const container = clientSearchRef.current
      if (!container) return
      if (!container.contains(e.target as Node)) {
        setClientSuggestions([])
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    if (selectedClientId) return
    const handle = setTimeout(() => {
      void loadClientSuggestions(companyName)
    }, 200)
    return () => clearTimeout(handle)
  }, [companyName, loadClientSuggestions, selectedClientId])

  // Track if initial load is complete
  const [initialLoadComplete, setInitialLoadComplete] = useState(false)

  // Set the saved snapshot once initial load populates all state
  useEffect(() => {
    if (initialLoadComplete && savedSnapshot === '') {
      setSavedSnapshot(currentSnapshot)
    }
  }, [initialLoadComplete, savedSnapshot, currentSnapshot])

  // Reset active desktop section when video sections become unavailable
  useEffect(() => {
    const videoOnlySections = ['video-processing', 'feedback']
    if (!enableVideos && videoOnlySections.includes(activeSection)) {
      setActiveSection('project-details')
    }
  }, [enableVideos, activeSection])

  async function handleSave() {
    if (!canChangeProjectSettings) {
      setError('Forbidden')
      return
    }
    setSaving(true)
    setError('')
    setSuccess(false)

    if (!selectedClientId) {
      setError('Please choose an existing client')
      setSaving(false)
      return
    }

    try {
      const sanitizedSlug = sanitizeSlug(slug)

      if (!sanitizedSlug) {
        setError('Share link cannot be empty')
        setSaving(false)
        return
      }

      // Validate OTP requirements
      if ((authMode === 'OTP' || authMode === 'BOTH') && !smtpConfigured) {
        setError('OTP authentication requires SMTP configuration. Please configure email settings first.')
        setSaving(false)
        return
      }

      if ((authMode === 'OTP' || authMode === 'BOTH') && !hasRecipientWithEmail) {
        setError('OTP authentication requires at least one recipient with an email address. Please add recipients first.')
        setSaving(false)
        return
      }

      const updates: any = {
        title,
        slug: sanitizedSlug,
        description: description || null,
        clientId: selectedClientId,
        enableVideos,
        enablePhotos,
        enableUploads,
        restrictCommentsToLatestVersion,
        hideFeedback,
        useFullTimecode,
        allowClientDeleteComments,
        enableClientUploads,
        allowClientUploadFiles,
        allowAuthenticatedProjectSwitching,
        maxClientUploadAllocationMB: typeof maxClientUploadAllocationMB === 'number'
          ? maxClientUploadAllocationMB
          : parseInt(String(maxClientUploadAllocationMB), 10) || 0,
        previewResolutions,
        sharePassword: sharePassword || null,
        authMode,
        clientNotificationSchedule,
        clientNotificationTime: clientNotificationSchedule === 'DAILY' ? clientNotificationTime : null,
        clientNotificationDay: null,
      }

      // Resolution list changes only need previews generated for the newly-added resolutions.
      const addedPreviewResolutions = previewResolutions.filter(
        (resolution) => !originalSettings.previewResolutions.includes(resolution)
      )
      const removedPreviewResolutions = originalSettings.previewResolutions.filter(
        (resolution) => !previewResolutions.includes(resolution)
      )

      if (addedPreviewResolutions.length > 0 || removedPreviewResolutions.length > 0) {
        updates.addedPreviewResolutions = addedPreviewResolutions
      }

      await saveSettings(updates)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
      setSaving(false)
    }
  }

  async function saveSettings(updates: any, shouldReprocess = false) {
    setSaving(true)
    setError('')

    try {
      // Save project settings
      const { addedPreviewResolutions, ...apiUpdates } = updates
      const patchResult = await apiPatch<any>(`/api/projects/${projectId}`, apiUpdates)

      // If S3 mode and a rename is needed, the server returns 202 asking us to confirm.
      if (patchResult?.requiresJobConfirmation) {
        setPendingRenameReprocess(shouldReprocess)
        setPendingRenameUpdates(updates)
        setPendingRenameTitle(patchResult.proposedTitle ?? title)
        setRenameSizeInfo(null)
        setRenameConfirmOpen(true)
        setSaving(false)
        // Kick off size fetch in the background so it appears when modal opens
        setRenameSizeLoading(true)
        apiFetch(`/api/projects/${projectId}/rename-size`)
          .then((r) => r.json())
          .then((data) => setRenameSizeInfo(data))
          .catch(() => {})
          .finally(() => setRenameSizeLoading(false))
        return
      }

      // Update custom slug value to sanitized version if using custom slug
      const sanitizedSlug = updates.slug
      if (useCustomSlug) {
        setCustomSlugValue(sanitizedSlug)
      }

      // Reprocess videos if requested
      if (shouldReprocess && !isProjectClosed) {
        await reprocessVideos()
      } else if (!isProjectClosed && Array.isArray(addedPreviewResolutions) && addedPreviewResolutions.length > 0) {
        await reprocessVideos({
          previewResolutions: addedPreviewResolutions,
          regenerateThumbnail: false,
          regenerateTimelinePreviews: false,
        })
      }

      // Delete preview files for resolutions that were removed
      const removedResolutions = originalSettings.previewResolutions.filter(
        (r: string) => !updates.previewResolutions?.includes(r)
      )
      if (removedResolutions.length > 0) {
        try {
          await apiPost(`/api/projects/${projectId}/delete-previews`, {
            resolutions: removedResolutions,
          })
        } catch (err) {
          console.error('Error deleting removed resolution previews:', err)
        }
      }

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)

      // Reset unsaved changes tracking - will be refreshed after state update from reload
      setSavedSnapshot('')

      // Reload project data to reflect changes
      const refreshResponse = await apiFetch(`/api/projects/${projectId}`)
      if (refreshResponse.ok) {
        const refreshedData = await refreshResponse.json()
        setProject(refreshedData)
        setAllowAuthenticatedProjectSwitching(refreshedData.allowAuthenticatedProjectSwitching ?? true)

        // Update original settings
        setOriginalSettings({
          title: refreshedData.title,
          previewResolutions: (() => {
            try {
              const parsed = JSON.parse(refreshedData.previewResolutions || '[]')
              return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['720p']
            } catch { return ['720p'] }
          })(),
        })
      }

      // Refresh the page
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  async function reprocessVideos(payload?: {
    previewResolutions?: string[]
    regenerateThumbnail?: boolean
    regenerateTimelinePreviews?: boolean
  }) {
    setReprocessing(true)
    try {
      await apiPost(`/api/projects/${projectId}/reprocess`, payload || {})
    } catch (err) {
      console.error('Error reprocessing videos:', err)
      // Don't throw - we still want to save settings
    } finally {
      setReprocessing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  const projectSections = [
    { id: 'project-details', label: 'Project Details', description: 'Basic project information and client details', icon: FileText },
    { id: 'notifications', label: 'Notifications', description: 'Set notification schedule for client recipients', icon: Bell },
    ...(enableVideos ? [
      { id: 'video-processing', label: 'Video Processing', description: 'Configure how videos are processed and displayed', icon: Video },
      { id: 'feedback', label: 'Feedback & Client Uploads', description: "Control clients ability to see or leave feedback and upload files", icon: MessageSquare },
    ] : []),
    { id: 'security', label: 'Security', description: 'Password protection for the share page', icon: Shield },
  ]

  if (!project) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Project not found</p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-(--breakpoint-2xl) mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
              <Link href={`/admin/projects/${projectId}`}>
                <Button variant="ghost" size="default" className="justify-start px-3">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  <span className="hidden sm:inline">Back to Project</span>
                  <span className="sm:hidden">Back</span>
                </Button>
              </Link>
              <div className="min-w-0">
                <h1 className="text-2xl sm:text-3xl font-bold">Project Settings</h1>
                <p className="text-sm sm:text-base text-muted-foreground mt-1 truncate">{project.title}</p>
              </div>
            </div>

            <Button onClick={handleSave} variant="default" disabled={saving || !canChangeProjectSettings} size="lg" className="w-full sm:w-auto">
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
            <p className="text-xs sm:text-sm text-destructive font-medium">{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-4 sm:mb-6 p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
            <p className="text-xs sm:text-sm text-success font-medium">Changes saved successfully!</p>
          </div>
        )}

        {/* Mobile: stacked collapsible cards (hidden on desktop) */}
        <div className="lg:hidden space-y-4 sm:space-y-6">
          {/* Project Details */}
          <Card className="border-border">
            <CardHeader
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setShowProjectDetails(!showProjectDetails)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Project Details</CardTitle>
                  <CardDescription>
                    Basic project information and client details
                  </CardDescription>
                </div>
                {showProjectDetails ? (
                  <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                )}
              </div>
            </CardHeader>

            {showProjectDetails && (
              <CardContent className="space-y-4 border-t pt-4">
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="space-y-2">
                  <Label htmlFor="title">Project Title</Label>
                  <Input
                    id="title"
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g., Brand Video Project"
                  />
                  <p className="text-xs text-muted-foreground">
                    The name of this project as shown to clients and in the admin panel
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Project Type</Label>
                  <div className="grid grid-cols-3 gap-x-8 gap-y-1">
                    <div className="min-w-0">
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={enableVideos}
                          onChange={(e) => setEnableVideos(e.target.checked)}
                          disabled={(project?._count?.videos ?? 0) > 0 && enableVideos}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60"
                        />
                        Video
                      </label>
                      {(project?._count?.videos ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Remove existing videos to disable them in this project.
                        </p>
                      )}
                    </div>

                    <div className="min-w-0">
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={enablePhotos}
                          onChange={(e) => setEnablePhotos(e.target.checked)}
                          disabled={(project?._count?.albums ?? 0) > 0 && enablePhotos}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60"
                        />
                        Photo
                      </label>
                      {(project?._count?.albums ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Remove existing albums to disable them in this project.
                        </p>
                      )}
                    </div>

                    <div className="min-w-0">
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={enableUploads}
                          onChange={(e) => setEnableUploads(e.target.checked)}
                          disabled={(project?._count?.shareUploadFiles ?? 0) > 0 && enableUploads}
                          className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60"
                        />
                        Uploads
                      </label>
                      {(project?._count?.shareUploadFiles ?? 0) > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Remove existing uploaded files to disable Uploads in this project.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Project Description</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g., Marketing video for Q4 campaign"
                    rows={3}
                    autoResize
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional description to help identify and organize this project
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="companyName">Company/Brand Name</Label>
                  <div className="relative" ref={clientSearchRef}>
                    <Input
                      id="companyName"
                      type="text"
                      value={companyName}
                      onChange={(e) => {
                        setCompanyName(e.target.value)
                        setSelectedClientId(null)
                      }}
                      placeholder="Search clients..."
                      maxLength={100}
                      autoComplete="off"
                    />

                    {clientSuggestions.length > 0 && !selectedClientId && (
                      <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-sm overflow-hidden">
                        {clientSuggestions.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40"
                            onClick={() => {
                              setSelectedClientId(c.id)
                              setCompanyName(c.name)
                              setClientSuggestions([])
                            }}
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Choose an existing Client. Start typing to search.
                    {clientsLoading ? ' Searching…' : ''}
                  </p>
                </div>
              </div>

              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="useCustomSlug">Custom Link</Label>
                    <p className="text-xs text-muted-foreground">
                      Use a custom share link instead of auto-generated from project title
                    </p>
                  </div>
                  <Switch
                    id="useCustomSlug"
                    checked={useCustomSlug}
                    onCheckedChange={setUseCustomSlug}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug">Share Link</Label>
                  <div className="flex gap-2 items-center">
                    <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">
                      /share/
                    </span>
                    {useCustomSlug ? (
                      <>
                        <Input
                          id="slug"
                          type="text"
                          value={customSlugValue}
                          onChange={(e) => setCustomSlugValue(e.target.value)}
                          placeholder="e.g., custom-link-name"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setCustomSlugValue(generateRandomSlug())}
                          title="Generate random URL"
                          className="h-10 w-10 p-0 shrink-0"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      </>
                    ) : (
                      <Input
                        id="slug"
                        type="text"
                        value={autoGeneratedSlug}
                        disabled
                        className="flex-1 opacity-60"
                      />
                    )}
                  </div>
                  {useCustomSlug && customSlugValue && customSlugValue !== sanitizedSlug && (
                    <p className="text-xs text-warning">
                      Will be saved as: <span className="font-mono font-semibold">{sanitizedSlug}</span>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {useCustomSlug
                      ? 'Custom share link. Only lowercase letters, numbers, and hyphens allowed.'
                      : 'Auto-generated from project title. Enable "Custom Link" to set your own.'}
                  </p>
                </div>
              </div>
            </CardContent>
            )}
          </Card>

          {/* Notifications */}
          <Card className="border-border">
            <CardHeader
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setShowClientInfo(!showClientInfo)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Notifications</CardTitle>
                  <CardDescription>
                    Set notification schedule for client recipients
                  </CardDescription>
                </div>
                {showClientInfo ? (
                  <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                )}
              </div>
            </CardHeader>

            {showClientInfo && (
              <CardContent className="space-y-6 border-t pt-4">
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <ScheduleSelector
                  schedule={clientNotificationSchedule}
                  time={clientNotificationTime}
                  day={clientNotificationDay}
                  onScheduleChange={setClientNotificationSchedule}
                  onTimeChange={setClientNotificationTime}
                  onDayChange={setClientNotificationDay}
                  label="Client Notification Schedule"
                  description="Configure when clients receive summaries of your replies for this project. Note: Approval emails are always sent immediately."
                />
              </div>
            </CardContent>
            )}
          </Card>

          {enableVideos && (
            <>
              {/* Video Processing Settings */}
              <Card className="border-border">
                <CardHeader
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setShowVideoProcessing(!showVideoProcessing)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Video Processing</CardTitle>
                      <CardDescription>
                        Configure how videos are processed and displayed
                      </CardDescription>
                    </div>
                    {showVideoProcessing ? (
                      <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}
                  </div>
                </CardHeader>

                {showVideoProcessing && (
                  <CardContent className="space-y-6 border-t pt-4">
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="space-y-2">
                      <Label>Preview Resolutions</Label>
                      <div className="space-y-2">
                        {[
                          { value: '480p', label: '480p (854x480 or 480x854 for vertical)' },
                          { value: '720p', label: '720p (1280x720 or 720x1280 for vertical)' },
                          { value: '1080p', label: '1080p (1920x1080 or 1080x1920 for vertical)' },
                        ].map((opt) => (
                          <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={previewResolutions.includes(opt.value)}
                              onChange={() => {
                                setPreviewResolutions(prev => {
                                  if (prev.includes(opt.value)) {
                                    if (prev.length <= 1) return prev
                                    return prev.filter(r => r !== opt.value)
                                  }
                                  return [...prev, opt.value]
                                })
                              }}
                              className="rounded border-border"
                            />
                            <span className="text-sm">{opt.label}</span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Select at least one resolution. Higher resolutions take longer to process and use more storage.
                        Vertical videos automatically adjust dimensions while maintaining aspect ratio.
                      </p>
                    </div>
                  </div>

                </CardContent>
                )}
              </Card>

              {/* Comment Settings */}
              <Card className="border-border">
                <CardHeader
                  className="cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setShowFeedback(!showFeedback)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Feedback & Client Uploads</CardTitle>
                      <CardDescription>
                        Control clients ability to see or leave feedback and upload files
                      </CardDescription>
                    </div>
                    {showFeedback ? (
                      <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                    )}
                  </div>
                </CardHeader>

                {showFeedback && (
                  <CardContent className="space-y-6 border-t pt-4">
                  {(project as any)?.status === 'SHARE_ONLY' && (
                    <div className="p-3 bg-warning-visible border-2 border-warning-visible rounded-lg">
                      <p className="text-sm text-warning font-medium">
                        This project is currently set to <b>Share Only</b> mode, which overrides some settings. The Feedback Section is always hidden in this mode and videos are restricted to their latest version. If a video is manually approved by Admin, authenticated clients (i.e. OTP and Password users) will be able to download the video.
                      </p>
                    </div>
                  )}
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="hideFeedback">Hide Feedback Section</Label>
                        <p className="text-xs text-muted-foreground">
                          Completely hide the Feedback & Discussion window from clients
                        </p>
                      </div>
                      <Switch
                        id="hideFeedback"
                        checked={hideFeedback}
                        onCheckedChange={setHideFeedback}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="restrictComments">Restrict Comments to Latest Version</Label>
                        <p className="text-xs text-muted-foreground">
                          Only allow feedback on the most recent video version
                        </p>
                      </div>
                      <Switch
                        id="restrictComments"
                        checked={restrictCommentsToLatestVersion}
                        onCheckedChange={setRestrictCommentsToLatestVersion}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="useFullTimecode">Display Full Timecode</Label>
                        <p className="text-xs text-muted-foreground">
                          Show comment timestamps as full timecode (HH:MM:SS:FF / DF) instead of M:SS.
                        </p>
                      </div>
                      <Switch
                        id="useFullTimecode"
                        checked={useFullTimecode}
                        onCheckedChange={setUseFullTimecode}
                      />
                    </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowClientDeleteComments">Allow clients to delete client comments</Label>
                    <p className="text-xs text-muted-foreground">
                      All clients will be able to delete any comment left by a client.
                    </p>
                  </div>
                  <Switch
                    id="allowClientDeleteComments"
                    checked={allowClientDeleteComments}
                    onCheckedChange={setAllowClientDeleteComments}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="enableClientUploads">Enable Share Page Uploads for clients</Label>
                    <p className="text-xs text-muted-foreground">
                      Show the UPLOADS folder to authenticated clients in the FILES mode of the Share page. When disabled, the UPLOADS section is hidden from clients but stays visible to admins (as long as the Uploads project type is enabled).
                    </p>
                  </div>
                  <Switch
                    id="enableClientUploads"
                    checked={enableClientUploads}
                    onCheckedChange={setEnableClientUploads}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowClientUploadFiles">Allow clients to upload files to Projects</Label>
                    <p className="text-xs text-muted-foreground">
                      Authenticated clients can upload files with comments on the Share page and to the UPLOADS directory (if enabled). Supported: Images, Videos, Audio files, PDFs, Documents, Fonts, Archives.
                    </p>
                  </div>
                  <Switch
                    id="allowClientUploadFiles"
                    checked={allowClientUploadFiles}
                    onCheckedChange={setAllowClientUploadFiles}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="maxClientUploadAllocationMB">Max allowed data allocation for project uploads</Label>
                    <p className="text-xs text-muted-foreground">
                      Quota applies to total project uploads (comment attachments + UPLOADS files). Zero = no limit.
                    </p>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <Input
                      id="maxClientUploadAllocationMB"
                      type="number"
                      min={0}
                      value={maxClientUploadAllocationMB}
                      onChange={(e) => {
                        const val = e.target.value
                        setMaxClientUploadAllocationMB(val === '' ? '' : Math.max(0, parseInt(val, 10) || 0))
                      }}
                      className="w-20"
                    />
                    <span className="text-sm text-muted-foreground">MB</span>
                  </div>
                </div>
              </div>
            </CardContent>
            )}
          </Card>

            </>
          )}

          {/* Security Settings */}
          <Card className="border-border">
            <CardHeader
              className="cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setShowSecurity(!showSecurity)}
            >
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Security</CardTitle>
                  <CardDescription>
                    Password protection for the share page
                  </CardDescription>
                </div>
                {showSecurity ? (
                  <ChevronUp className="w-5 h-5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-muted-foreground shrink-0" />
                )}
              </div>
            </CardHeader>

            {showSecurity && (
              <CardContent className="space-y-4 border-t pt-4">
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="space-y-2">
                  <Label htmlFor="authMode">Authentication Method</Label>
                  <select
                    id="authMode"
                    value={authMode}
                    onChange={(e) => setAuthMode(e.target.value)}
                    className="w-full px-3 py-2 bg-card border border-border rounded-md"
                  >
                    <option value="PASSWORD">Password Only</option>
                    <option value="OTP" disabled={!smtpConfigured || !hasRecipientWithEmail}>
                      Email OTP Only {!smtpConfigured || !hasRecipientWithEmail ? '(requires SMTP & recipients)' : ''}
                    </option>
                    <option value="BOTH" disabled={!smtpConfigured || !hasRecipientWithEmail}>
                      Both Password and OTP {!smtpConfigured || !hasRecipientWithEmail ? '(requires SMTP & recipients)' : ''}
                    </option>
                    <option value="NONE">No Authentication</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {authMode === 'PASSWORD' && 'Clients must enter a password to access the project'}
                    {authMode === 'OTP' && 'Clients receive a one-time code via email (must be a registered recipient)'}
                    {authMode === 'BOTH' && 'Clients can choose between password or email OTP authentication'}
                    {authMode === 'NONE' && 'Anyone with the share link can access the project'}
                  </p>
                  {!smtpConfigured && authMode !== 'NONE' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Configure SMTP in Settings to enable OTP authentication options
                    </p>
                  )}
                  {smtpConfigured && !hasRecipientWithEmail && authMode !== 'NONE' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Add at least one recipient with an email address to enable OTP authentication options
                    </p>
                  )}
                </div>

                {authMode === 'NONE' && (
                  <div className="flex items-start gap-2 p-3 bg-warning-visible border-2 border-warning-visible rounded-md">
                    <span className="text-warning text-sm font-bold">!</span>
                    <p className="text-sm text-warning font-medium">
                      Without authentication, anyone with the share link can access your project. Full access allows comments and approvals from anyone.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5 flex-1">
                    <Label htmlFor="allowAuthenticatedProjectSwitching">Allow authenticated clients to switch current projects</Label>
                    <p className="text-xs text-muted-foreground">
                      Password and OTP recipients can switch from this project to other current client projects and vice-versa when both projects allow it.
                    </p>
                    {(project?.globalAllowAuthenticatedProjectSwitching ?? true) === false && (
                      <p className="text-xs text-muted-foreground mt-1">
                        This setting is currently disabled globally in Default Project Settings.
                      </p>
                    )}
                  </div>
                  <Switch
                    id="allowAuthenticatedProjectSwitching"
                    checked={allowAuthenticatedProjectSwitching}
                    onCheckedChange={setAllowAuthenticatedProjectSwitching}
                    disabled={(project?.globalAllowAuthenticatedProjectSwitching ?? true) === false}
                  />
                </div>
              </div>

              {(authMode === 'PASSWORD' || authMode === 'BOTH') && (
              <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                <div className="space-y-2">
                  <Label htmlFor="password">Share Page Password</Label>
                  <div className="flex gap-2 w-full">
                    <PasswordInput
                      id="password"
                      value={sharePassword}
                      onChange={(e) => setSharePassword(e.target.value)}
                      placeholder="Enter password for share page"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSharePassword(generateSecurePassword())}
                      title="Generate random password"
                      className="h-10 w-10 p-0 shrink-0"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                    {sharePassword && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={copyPassword}
                        title={copiedPassword ? 'Copied!' : 'Copy password'}
                        className="h-10 w-10 p-0 shrink-0"
                      >
                        {copiedPassword ? (
                          <Check className="w-4 h-4 text-success" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </div>
                  {sharePassword && (
                    <SharePasswordRequirements password={sharePassword} />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Clients will need this password to access the share page
                  </p>
                </div>
              </div>
              )}
            </CardContent>
            )}
          </Card>

        </div>

        {/* Desktop: sidebar nav + content panel (hidden on mobile) */}
        <div className="hidden lg:flex gap-6 mt-4">
          {/* Left sidebar */}
          <div className="w-52 xl:w-60 shrink-0">
            <nav className="space-y-0.5 sticky top-6">
              {projectSections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-md text-sm flex items-center gap-2.5 transition-colors',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <section.icon className="w-4 h-4 shrink-0" />
                  {section.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content panel */}
          <div className="flex-1 min-w-0">
            {activeSection === 'project-details' && (
              <Card className="border-border">
                <CardHeader>
                  <CardTitle>Project Details</CardTitle>
                  <CardDescription>Basic project information and client details</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 border-t pt-4">
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="space-y-2">
                      <Label htmlFor="title-d">Project Title</Label>
                      <Input id="title-d" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Brand Video Project" />
                      <p className="text-xs text-muted-foreground">The name of this project as shown to clients and in the admin panel</p>
                    </div>

                    <div className="space-y-2">
                      <Label>Project Type</Label>
                      <div className="grid grid-cols-3 gap-x-8 gap-y-1">
                        <div className="min-w-0">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={enableVideos} onChange={(e) => setEnableVideos(e.target.checked)} disabled={(project?._count?.videos ?? 0) > 0 && enableVideos} className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60" />
                            Video
                          </label>
                          {(project?._count?.videos ?? 0) > 0 && <p className="text-xs text-muted-foreground mt-1">Remove existing videos to disable them in this project.</p>}
                        </div>
                        <div className="min-w-0">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={enablePhotos} onChange={(e) => setEnablePhotos(e.target.checked)} disabled={(project?._count?.albums ?? 0) > 0 && enablePhotos} className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60" />
                            Photo
                          </label>
                          {(project?._count?.albums ?? 0) > 0 && <p className="text-xs text-muted-foreground mt-1">Remove existing albums to disable them in this project.</p>}
                        </div>
                        <div className="min-w-0">
                          <label className="inline-flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={enableUploads} onChange={(e) => setEnableUploads(e.target.checked)} disabled={(project?._count?.shareUploadFiles ?? 0) > 0 && enableUploads} className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:opacity-60" />
                            Uploads
                          </label>
                          {(project?._count?.shareUploadFiles ?? 0) > 0 && <p className="text-xs text-muted-foreground mt-1">Remove existing uploaded files to disable Uploads in this project.</p>}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="description-d">Project Description</Label>
                      <Textarea id="description-d" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g., Marketing video for Q4 campaign" rows={3} autoResize />
                      <p className="text-xs text-muted-foreground">Optional description to help identify and organize this project</p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="companyName-d">Company/Brand Name</Label>
                      <div className="relative" ref={clientSearchRef}>
                        <Input id="companyName-d" type="text" value={companyName} onChange={(e) => { setCompanyName(e.target.value); setSelectedClientId(null) }} placeholder="Search clients..." maxLength={100} autoComplete="off" />
                        {clientSuggestions.length > 0 && !selectedClientId && (
                          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-sm overflow-hidden">
                            {clientSuggestions.map((c) => (
                              <button key={c.id} type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-muted/40" onClick={() => { setSelectedClientId(c.id); setCompanyName(c.name); setClientSuggestions([]) }}>
                                {c.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">Choose an existing Client. Start typing to search.{clientsLoading ? ' Searching…' : ''}</p>
                    </div>
                  </div>

                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="useCustomSlug-d">Custom Link</Label>
                        <p className="text-xs text-muted-foreground">Use a custom share link instead of auto-generated from project title</p>
                      </div>
                      <Switch id="useCustomSlug-d" checked={useCustomSlug} onCheckedChange={setUseCustomSlug} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="slug-d">Share Link</Label>
                      <div className="flex gap-2 items-center">
                        <span className="text-xs sm:text-sm text-muted-foreground whitespace-nowrap">/share/</span>
                        {useCustomSlug ? (
                          <>
                            <Input id="slug-d" type="text" value={customSlugValue} onChange={(e) => setCustomSlugValue(e.target.value)} placeholder="e.g., custom-link-name" className="flex-1" />
                            <Button type="button" variant="outline" size="sm" onClick={() => setCustomSlugValue(generateRandomSlug())} title="Generate random URL" className="h-10 w-10 p-0 shrink-0">
                              <RefreshCw className="w-4 h-4" />
                            </Button>
                          </>
                        ) : (
                          <Input id="slug-d" type="text" value={autoGeneratedSlug} disabled className="flex-1 opacity-60" />
                        )}
                      </div>
                      {useCustomSlug && customSlugValue && customSlugValue !== sanitizedSlug && (
                        <p className="text-xs text-warning">Will be saved as: <span className="font-mono font-semibold">{sanitizedSlug}</span></p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {useCustomSlug ? 'Custom share link. Only lowercase letters, numbers, and hyphens allowed.' : 'Auto-generated from project title. Enable "Custom Link" to set your own.'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'notifications' && (
              <Card className="border-border">
                <CardHeader>
                  <CardTitle>Notifications</CardTitle>
                  <CardDescription>Set notification schedule for client recipients</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 border-t pt-4">
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <ScheduleSelector
                      schedule={clientNotificationSchedule}
                      time={clientNotificationTime}
                      day={clientNotificationDay}
                      onScheduleChange={setClientNotificationSchedule}
                      onTimeChange={setClientNotificationTime}
                      onDayChange={setClientNotificationDay}
                      label="Client Notification Schedule"
                      description="Configure when clients receive summaries of your replies for this project. Note: Approval emails are always sent immediately."
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'video-processing' && (
              <Card className="border-border">
                <CardHeader>
                  <CardTitle>Video Processing</CardTitle>
                  <CardDescription>Configure how videos are processed and displayed</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 border-t pt-4">
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="space-y-2">
                      <Label>Preview Resolutions</Label>
                      <div className="space-y-2">
                        {[
                          { value: '480p', label: '480p (854x480 or 480x854 for vertical)' },
                          { value: '720p', label: '720p (1280x720 or 720x1280 for vertical)' },
                          { value: '1080p', label: '1080p (1920x1080 or 1080x1920 for vertical)' },
                        ].map((opt) => (
                          <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={previewResolutions.includes(opt.value)} onChange={() => { setPreviewResolutions(prev => { if (prev.includes(opt.value)) { if (prev.length <= 1) return prev; return prev.filter(r => r !== opt.value) } return [...prev, opt.value] }) }} className="rounded border-border" />
                            <span className="text-sm">{opt.label}</span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">Select at least one resolution. Higher resolutions take longer to process and use more storage.</p>
                    </div>
                  </div>

                </CardContent>
              </Card>
            )}

            {activeSection === 'feedback' && (
              <Card className="border-border">
                <CardHeader>
                  <CardTitle>Feedback &amp; Client Uploads</CardTitle>
                  <CardDescription>Control clients ability to see or leave feedback and upload files</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6 border-t pt-4">
                  {(project as any)?.status === 'SHARE_ONLY' && (
                    <div className="p-3 bg-warning-visible border-2 border-warning-visible rounded-lg">
                      <p className="text-sm text-warning font-medium">This project is currently set to <b>Share Only</b> mode, which overrides some settings. The Feedback Section is always hidden in this mode and videos are restricted to their latest version. If a video is manually approved by Admin, authenticated clients (i.e. OTP and Password users) will be able to download the video.</p>
                    </div>
                  )}
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="hideFeedback-d">Hide Feedback Section</Label>
                        <p className="text-xs text-muted-foreground">Completely hide the Feedback &amp; Discussion window from clients</p>
                      </div>
                      <Switch id="hideFeedback-d" checked={hideFeedback} onCheckedChange={setHideFeedback} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="restrictComments-d">Restrict Comments to Latest Version</Label>
                        <p className="text-xs text-muted-foreground">Only allow feedback on the most recent video version</p>
                      </div>
                      <Switch id="restrictComments-d" checked={restrictCommentsToLatestVersion} onCheckedChange={setRestrictCommentsToLatestVersion} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="useFullTimecode-d">Display Full Timecode</Label>
                        <p className="text-xs text-muted-foreground">Show comment timestamps as full timecode (HH:MM:SS:FF / DF) instead of M:SS.</p>
                      </div>
                      <Switch id="useFullTimecode-d" checked={useFullTimecode} onCheckedChange={setUseFullTimecode} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="allowClientDeleteComments-d">Allow clients to delete client comments</Label>
                        <p className="text-xs text-muted-foreground">All clients will be able to delete any comment left by a client.</p>
                      </div>
                      <Switch id="allowClientDeleteComments-d" checked={allowClientDeleteComments} onCheckedChange={setAllowClientDeleteComments} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="enableClientUploads-d">Enable Share Page Uploads for clients</Label>
                        <p className="text-xs text-muted-foreground">Show the UPLOADS folder to authenticated clients in the FILES mode of the Share page. When disabled, the UPLOADS section is hidden from clients but stays visible to admins (as long as the Uploads project type is enabled).</p>
                      </div>
                      <Switch id="enableClientUploads-d" checked={enableClientUploads} onCheckedChange={setEnableClientUploads} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="allowClientUploadFiles-d">Allow clients to upload files to Projects</Label>
                        <p className="text-xs text-muted-foreground">Authenticated clients can upload files with comments on the Share page and to the UPLOADS directory (if enabled). Supported: Images, Videos, Audio files, PDFs, Documents, Fonts, Archives.</p>
                      </div>
                      <Switch id="allowClientUploadFiles-d" checked={allowClientUploadFiles} onCheckedChange={setAllowClientUploadFiles} />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="maxClientUploadAllocationMB-d">Max allowed data allocation for project uploads</Label>
                        <p className="text-xs text-muted-foreground">Quota applies to total project uploads (comment attachments + UPLOADS files). Zero = no limit.</p>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <Input id="maxClientUploadAllocationMB-d" type="number" min={0} value={maxClientUploadAllocationMB} onChange={(e) => { const val = e.target.value; setMaxClientUploadAllocationMB(val === '' ? '' : Math.max(0, parseInt(val, 10) || 0)) }} className="w-20" />
                        <span className="text-sm text-muted-foreground">MB</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'security' && (
              <Card className="border-border">
                <CardHeader>
                  <CardTitle>Security</CardTitle>
                  <CardDescription>Password protection for the share page</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 border-t pt-4">
                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="space-y-2">
                      <Label htmlFor="authMode-d">Authentication Method</Label>
                      <select id="authMode-d" value={authMode} onChange={(e) => setAuthMode(e.target.value)} className="w-full px-3 py-2 bg-card border border-border rounded-md">
                        <option value="PASSWORD">Password Only</option>
                        <option value="OTP" disabled={!smtpConfigured || !hasRecipientWithEmail}>Email OTP Only {!smtpConfigured || !hasRecipientWithEmail ? '(requires SMTP & recipients)' : ''}</option>
                        <option value="BOTH" disabled={!smtpConfigured || !hasRecipientWithEmail}>Both Password and OTP {!smtpConfigured || !hasRecipientWithEmail ? '(requires SMTP & recipients)' : ''}</option>
                        <option value="NONE">No Authentication</option>
                      </select>
                      <p className="text-xs text-muted-foreground">
                        {authMode === 'PASSWORD' && 'Clients must enter a password to access the project'}
                        {authMode === 'OTP' && 'Clients receive a one-time code via email (must be a registered recipient)'}
                        {authMode === 'BOTH' && 'Clients can choose between password or email OTP authentication'}
                        {authMode === 'NONE' && 'Anyone with the share link can access the project'}
                      </p>
                      {!smtpConfigured && authMode !== 'NONE' && <p className="text-xs text-muted-foreground mt-1">Configure SMTP in Settings to enable OTP authentication options</p>}
                      {smtpConfigured && !hasRecipientWithEmail && authMode !== 'NONE' && <p className="text-xs text-muted-foreground mt-1">Add at least one recipient with an email address to enable OTP authentication options</p>}
                    </div>
                    {authMode === 'NONE' && (
                      <div className="flex items-start gap-2 p-3 bg-warning-visible border-2 border-warning-visible rounded-md">
                        <span className="text-warning text-sm font-bold">!</span>
                        <p className="text-sm text-warning font-medium">Without authentication, anyone with the share link can access your project. Full access allows comments and approvals from anyone.</p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-0.5 flex-1">
                        <Label htmlFor="allowAuthenticatedProjectSwitching-d">Allow authenticated clients to switch current projects</Label>
                        <p className="text-xs text-muted-foreground">Password and OTP recipients can switch from this project to other current client projects and vice-versa when both projects allow it.</p>
                        {(project?.globalAllowAuthenticatedProjectSwitching ?? true) === false && (
                          <p className="text-xs text-muted-foreground mt-1">This setting is currently disabled globally in Default Project Settings.</p>
                        )}
                      </div>
                      <Switch id="allowAuthenticatedProjectSwitching-d" checked={allowAuthenticatedProjectSwitching} onCheckedChange={setAllowAuthenticatedProjectSwitching} disabled={(project?.globalAllowAuthenticatedProjectSwitching ?? true) === false} />
                    </div>
                  </div>

                  {(authMode === 'PASSWORD' || authMode === 'BOTH') && (
                    <div className="space-y-3 border p-4 rounded-lg bg-muted/30">
                      <div className="space-y-2">
                        <Label htmlFor="password-d">Share Page Password</Label>
                        <div className="flex gap-2 w-full">
                          <PasswordInput id="password-d" value={sharePassword} onChange={(e) => setSharePassword(e.target.value)} placeholder="Enter password for share page" className="flex-1" />
                          <Button type="button" variant="outline" size="sm" onClick={() => setSharePassword(generateSecurePassword())} title="Generate random password" className="h-10 w-10 p-0 shrink-0">
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                          {sharePassword && (
                            <Button type="button" variant="outline" size="sm" onClick={copyPassword} title={copiedPassword ? 'Copied!' : 'Copy password'} className="h-10 w-10 p-0 shrink-0">
                              {copiedPassword ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                            </Button>
                          )}
                        </div>
                        {sharePassword && <SharePasswordRequirements password={sharePassword} />}
                        <p className="text-xs text-muted-foreground">Clients will need this password to access the share page</p>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Error notification at bottom */}
        {error && (
          <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
            <p className="text-xs sm:text-sm text-destructive font-medium">{error}</p>
          </div>
        )}

        {/* Success notification at bottom */}
        {success && (
          <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
            <p className="text-xs sm:text-sm text-success font-medium">Changes saved successfully!</p>
          </div>
        )}

        {/* Save button at bottom */}
        <div className="mt-6 sm:mt-8 pb-20 lg:pb-24 flex justify-end">
          <Button onClick={handleSave} variant="default" disabled={saving || !canChangeProjectSettings} size="lg" className="w-full sm:w-auto">
            <Save className="w-4 h-4 mr-2" />
            {saving ? 'Saving...' : 'Save All Changes'}
          </Button>
        </div>

        {/* S3 folder rename confirmation modal */}
        {renameConfirmOpen && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-card border border-border rounded-lg max-w-lg w-full p-6 space-y-4">
              <div className="flex items-start gap-3">
                <FolderSync className="w-6 h-6 text-warning shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h2 className="text-xl font-bold">Rename Requires Background Copy</h2>
                  <p className="text-sm text-muted-foreground mt-2">
                    Because files are stored on S3, renaming <strong>{pendingRenameTitle}</strong> requires copying all existing files to a new location. This may take several minutes depending on the project size.
                  </p>
                </div>
              </div>

              <div className="bg-muted/30 border border-border rounded-lg p-4 space-y-2 text-sm">
                {renameSizeLoading ? (
                  <p className="text-muted-foreground flex items-center gap-2">
                    <FolderSync className="w-4 h-4 animate-spin" />
                    Calculating project size…
                  </p>
                ) : renameSizeInfo ? (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {renameSizeInfo.totalObjects} file{renameSizeInfo.totalObjects !== 1 ? 's' : ''}
                    </span>{' '}
                    ·{' '}
                    <span className="font-medium text-foreground">
                      {(Number(renameSizeInfo.totalBytes) / (1024 ** 3)).toFixed(2)} GB
                    </span>{' '}
                    to copy
                  </p>
                ) : null}
                <ul className="space-y-1 ml-4 list-disc text-muted-foreground">
                  <li>The project will be locked for uploads during the copy</li>
                  <li>Progress will appear in the Running Jobs indicator</li>
                  <li>Original files remain intact until the copy completes</li>
                </ul>
              </div>

              <div className="flex gap-3 justify-end pt-2">
                <Button
                  variant="outline"
                  disabled={renameConfirming}
                  onClick={() => {
                    setRenameConfirmOpen(false)
                    setRenameSizeInfo(null)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={renameConfirming}
                  onClick={async () => {
                    setRenameConfirming(true)
                    try {
                      await apiPost(`/api/projects/${projectId}/rename-confirm`, { title: pendingRenameTitle })
                      setRenameConfirmOpen(false)
                      setRenameSizeInfo(null)
                      // Re-save the full settings payload now that rename-confirm has saved
                      // the title. The second PATCH won't trigger another 202 since the
                      // title now matches the DB, and it clears the unsaved-changes state.
                      if (pendingRenameUpdates) {
                        setPendingRenameUpdates(null)
                        await saveSettings(pendingRenameUpdates, pendingRenameReprocess)
                      } else if (pendingRenameReprocess && !isProjectClosed) {
                        await reprocessVideos()
                      }
                    } catch (err: any) {
                      setError(err?.message || 'Failed to start rename')
                    } finally {
                      setRenameConfirming(false)
                    }
                  }}
                >
                  {renameConfirming ? (
                    <><FolderSync className="w-4 h-4 mr-2 animate-spin" />Starting…</>
                  ) : (
                    'Start rename in background'
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
