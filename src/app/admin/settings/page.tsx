'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Settings as SettingsIcon, Save, Palette, Globe, Mail, Cpu, HardDrive, Cloud, Video, FolderKanban, Wrench, Bell, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CompanyBrandingSection } from '@/components/settings/CompanyBrandingSection'
import { DomainConfigurationSection } from '@/components/settings/DomainConfigurationSection'
import { EmailSettingsSection } from '@/components/settings/EmailSettingsSection'
import { VideoProcessingSettingsSection } from '@/components/settings/VideoProcessingSettingsSection'
import { ProjectBehaviorSection } from '@/components/settings/ProjectBehaviorSection'
import { DeveloperToolsSection } from '@/components/settings/DeveloperToolsSection'
import { SecuritySettingsSection } from '@/components/settings/SecuritySettingsSection'
import { CpuConfigurationSection } from '@/components/settings/CpuConfigurationSection'
import { PushNotificationsSection } from '@/components/settings/PushNotificationsSection'
import { DropboxStorageSection } from '@/components/settings/DropboxStorageSection'
import { StorageOverviewSection } from '@/components/settings/StorageOverviewSection'
import { apiPatch, apiPost, apiFetch } from '@/lib/api-client'
import {
  DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
  DEFAULT_UPLOAD_CHUNK_SIZE_MB,
  MAX_DOWNLOAD_CHUNK_SIZE_MB,
  MAX_UPLOAD_CHUNK_SIZE_MB,
  MIN_DOWNLOAD_CHUNK_SIZE_MB,
  MIN_UPLOAD_CHUNK_SIZE_MB,
} from '@/lib/transfer-tuning'
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges'

interface Settings {
  id: string
  companyName: string | null
  companyLogoMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyLogoPath?: string | null
  companyLogoUrl?: string | null
  companyFaviconMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyFaviconPath?: string | null
  companyFaviconUrl?: string | null
  darkLogoEnabled?: boolean | null
  darkLogoMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  darkLogoPath?: string | null
  darkLogoUrl?: string | null
  smtpServer: string | null
  smtpPort: number | null
  smtpUsername: string | null
  smtpPassword: string | null
  smtpFromAddress: string | null
  smtpSecure: string | null
  emailTrackingPixelsEnabled: boolean | null
  appDomain: string | null
  defaultPreviewResolution: string | null
  defaultWatermarkEnabled: boolean | null
  defaultTimelinePreviewsEnabled: boolean | null
  defaultWatermarkText: string | null
  defaultAllowClientDeleteComments: boolean | null
  defaultAllowClientUploadFiles: boolean | null
  defaultAllowAuthenticatedProjectSwitching: boolean | null
  defaultMaxClientUploadAllocationMB: number | null
  autoApproveProject: boolean | null
  autoCloseApprovedProjectsEnabled?: boolean | null
  autoCloseApprovedProjectsAfterDays?: number | null
  adminNotificationSchedule: string | null
  adminNotificationTime: string | null
  adminNotificationDay: number | null
  adminEmailProjectApproved: boolean | null
  adminEmailInternalComments: boolean | null
  adminEmailTaskComments: boolean | null
  adminEmailInvoicePaid: boolean | null
  adminEmailQuoteAccepted: boolean | null
  adminEmailProjectKeyDates: boolean | null
  adminEmailUserKeyDates: boolean | null
  defaultClientNotificationSchedule: string | null
  defaultClientNotificationTime: string | null
  defaultClientNotificationDay: number | null
  clientEmailProjectApproved: boolean | null
  excludeInternalIpsFromAnalytics?: boolean | null
  uploadChunkSizeMB?: number | null
  downloadChunkSizeMB?: number | null
}

interface SecuritySettings {
  id: string
  httpsEnabled: boolean
  hotlinkProtection: string
  ipRateLimit: number
  sessionRateLimit: number
  shareSessionRateLimit?: number
  shareTokenTtlSeconds?: number | null
  passwordAttempts: number
  sessionTimeoutValue: number
  sessionTimeoutUnit: string
  trackAnalytics: boolean
  trackSecurityLogs: boolean
  viewSecurityEvents: boolean

  maxInternalCommentsPerProject?: number
  maxCommentsPerVideoVersion?: number
  maxProjectRecipients?: number
  maxProjectFilesPerProject?: number
}

interface BlockedIP {
  id: string
  ipAddress: string
  reason: string | null
  createdAt: string
}

interface BlockedDomain {
  id: string
  domain: string
  reason: string | null
  createdAt: string
}

const SETTING_SECTIONS = [
  { id: 'company-branding', label: 'Company Branding', icon: Palette },
  { id: 'domain', label: 'Domain Configuration', icon: Globe },
  { id: 'email', label: 'Email & SMTP', icon: Mail },
  { id: 'cpu', label: 'CPU Configuration', icon: Cpu },
  { id: 'storage', label: 'Storage Overview', icon: HardDrive },
  { id: 'dropbox', label: 'Dropbox Storage', icon: Cloud },
  { id: 'video-processing', label: 'Default Project Settings', icon: Video },
  { id: 'project-behavior', label: 'Project Behavior', icon: FolderKanban },
  { id: 'developer-tools', label: 'Developer Tools', icon: Wrench },
  { id: 'push-notifications', label: 'Push Notifications', icon: Bell },
  { id: 'security', label: 'Advanced Security', icon: Shield },
] as const

export default function GlobalSettingsPage() {
  const router = useRouter()

  const [appVersion, setAppVersion] = useState<string | null>(null)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [securitySettings, setSecuritySettings] = useState<SecuritySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [testEmailSending, setTestEmailSending] = useState(false)
  const [testEmailResult, setTestEmailResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [testEmailAddress, setTestEmailAddress] = useState('')

  // Form state for global settings
  const [companyName, setCompanyName] = useState('')
  const [companyLogoVersion, setCompanyLogoVersion] = useState(0)
  const [companyLogoMode, setCompanyLogoMode] = useState<'NONE' | 'UPLOAD' | 'LINK'>('NONE')
  const [companyLogoUrl, setCompanyLogoUrl] = useState('')
  const [companyFaviconVersion, setCompanyFaviconVersion] = useState(0)
  const [companyFaviconMode, setCompanyFaviconMode] = useState<'NONE' | 'UPLOAD' | 'LINK'>('NONE')
  const [companyFaviconUrl, setCompanyFaviconUrl] = useState('')
  const [darkLogoEnabled, setDarkLogoEnabled] = useState(false)
  const [darkLogoVersion, setDarkLogoVersion] = useState(0)
  const [darkLogoMode, setDarkLogoMode] = useState<'NONE' | 'UPLOAD' | 'LINK'>('NONE')
  const [darkLogoUrl, setDarkLogoUrl] = useState('')
  const [accentColor, setAccentColor] = useState('')
  const [accentTextMode, setAccentTextMode] = useState<'LIGHT' | 'DARK'>('LIGHT')
  const [emailHeaderColor, setEmailHeaderColor] = useState('')
  const [emailHeaderTextMode, setEmailHeaderTextMode] = useState<'LIGHT' | 'DARK'>('LIGHT')
  const [defaultTheme, setDefaultTheme] = useState<'LIGHT' | 'DARK' | 'AUTO'>('DARK')
  const [allowThemeToggle, setAllowThemeToggle] = useState(true)
  const [smtpServer, setSmtpServer] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [emailTrackingPixelsEnabled, setEmailTrackingPixelsEnabled] = useState(true)
  const [emailCustomFooterText, setEmailCustomFooterText] = useState<string | null>(null)
  const [smtpFromAddress, setSmtpFromAddress] = useState('')
  const [smtpSecure, setSmtpSecure] = useState('STARTTLS')
  const [appDomain, setAppDomain] = useState('')
  const [mainCompanyDomain, setMainCompanyDomain] = useState('')
  const [defaultPreviewResolutions, setDefaultPreviewResolutions] = useState<string[]>(['720p'])
  const [defaultWatermarkEnabled, setDefaultWatermarkEnabled] = useState(true)
  const [defaultTimelinePreviewsEnabled, setDefaultTimelinePreviewsEnabled] = useState(false)
  const [defaultWatermarkText, setDefaultWatermarkText] = useState('')
  const [defaultAllowClientDeleteComments, setDefaultAllowClientDeleteComments] = useState(false)
  const [defaultAllowClientUploadFiles, setDefaultAllowClientUploadFiles] = useState(false)
  const [defaultAllowAuthenticatedProjectSwitching, setDefaultAllowAuthenticatedProjectSwitching] = useState(true)
  const [defaultMaxClientUploadAllocationMB, setDefaultMaxClientUploadAllocationMB] = useState<number | ''>(1000)
  const [autoApproveProject, setAutoApproveProject] = useState(true)
  const [autoDeletePreviewsOnClose, setAutoDeletePreviewsOnClose] = useState(false)
  const [excludeInternalIpsFromAnalytics, setExcludeInternalIpsFromAnalytics] = useState(true)
  const [uploadChunkSizeMB, setUploadChunkSizeMB] = useState<number | ''>(DEFAULT_UPLOAD_CHUNK_SIZE_MB)
  const [downloadChunkSizeMB, setDownloadChunkSizeMB] = useState<number | ''>(DEFAULT_DOWNLOAD_CHUNK_SIZE_MB)

  const [autoCloseApprovedProjectsEnabled, setAutoCloseApprovedProjectsEnabled] = useState(false)
  const [autoCloseApprovedProjectsAfterDays, setAutoCloseApprovedProjectsAfterDays] = useState<number | ''>(7)

  // Form state for admin notification settings
  const [adminNotificationSchedule, setAdminNotificationSchedule] = useState('HOURLY')
  const [adminNotificationTime, setAdminNotificationTime] = useState('09:00')
  const [adminNotificationDay, setAdminNotificationDay] = useState(1)
  const [adminEmailProjectApproved, setAdminEmailProjectApproved] = useState(true)
  const [adminEmailInternalComments, setAdminEmailInternalComments] = useState(true)
  const [adminEmailTaskComments, setAdminEmailTaskComments] = useState(true)
  const [adminEmailInvoicePaid, setAdminEmailInvoicePaid] = useState(true)
  const [adminEmailQuoteAccepted, setAdminEmailQuoteAccepted] = useState(true)
  const [adminEmailProjectKeyDates, setAdminEmailProjectKeyDates] = useState(true)
  const [adminEmailUserKeyDates, setAdminEmailUserKeyDates] = useState(true)

  // Form state for default client notification settings
  const [defaultClientNotificationSchedule, setDefaultClientNotificationSchedule] = useState('HOURLY')
  const [defaultClientNotificationTime, setDefaultClientNotificationTime] = useState('09:00')
  const [defaultClientNotificationDay, setDefaultClientNotificationDay] = useState(1)
  const [clientEmailProjectApproved, setClientEmailProjectApproved] = useState(true)

  useEffect(() => {
    let cancelled = false

    apiFetch('/api/meta/version')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const v = typeof data?.version === 'string' ? data.version : null
        setAppVersion(v)
      })
      .catch(() => {
        // ignore
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Form state for security settings
  const [showSecuritySettings, setShowSecuritySettings] = useState(false)
  const [httpsEnabled, setHttpsEnabled] = useState(false)
  const [hotlinkProtection, setHotlinkProtection] = useState('LOG_ONLY')
  const [ipRateLimit, setIpRateLimit] = useState('1000')
  const [sessionRateLimit, setSessionRateLimit] = useState('600')
  const [shareSessionRateLimit, setShareSessionRateLimit] = useState('300')
  const [shareTokenTtlSeconds, setShareTokenTtlSeconds] = useState('')
  const [passwordAttempts, setPasswordAttempts] = useState('5')
  const [sessionTimeoutValue, setSessionTimeoutValue] = useState('15')
  const [sessionTimeoutUnit, setSessionTimeoutUnit] = useState('MINUTES')
  const [trackAnalytics, setTrackAnalytics] = useState(true)
  const [trackSecurityLogs, setTrackSecurityLogs] = useState(true)
  const [viewSecurityEvents, setViewSecurityEvents] = useState(false)
  const [maxInternalCommentsPerProject, setMaxInternalCommentsPerProject] = useState('250')
  const [maxCommentsPerVideoVersion, setMaxCommentsPerVideoVersion] = useState('100')
  const [maxProjectRecipients, setMaxProjectRecipients] = useState('30')
  const [maxProjectFilesPerProject, setMaxProjectFilesPerProject] = useState('50')
  const [blockedIPs, setBlockedIPs] = useState<BlockedIP[]>([])
  const [blockedDomains, setBlockedDomains] = useState<BlockedDomain[]>([])
  const [newIP, setNewIP] = useState('')
  const [newIPReason, setNewIPReason] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [newDomainReason, setNewDomainReason] = useState('')
  const [blocklistsLoading, setBlocklistsLoading] = useState(false)

  // Form state for push notifications
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushNotifyUnauthorizedOTP, setPushNotifyUnauthorizedOTP] = useState(true)
  const [pushNotifyFailedAdminLogin, setPushNotifyFailedAdminLogin] = useState(true)
  const [pushNotifySuccessfulAdminLogin, setPushNotifySuccessfulAdminLogin] = useState(true)
  const [pushNotifyFailedSharePasswordAttempt, setPushNotifyFailedSharePasswordAttempt] = useState(true)
  const [pushNotifySuccessfulShareAccess, setPushNotifySuccessfulShareAccess] = useState(true)
  const [pushNotifyGuestVideoLinkAccess, setPushNotifyGuestVideoLinkAccess] = useState(true)
  const [pushNotifyClientComments, setPushNotifyClientComments] = useState(true)
  const [pushNotifyInternalComments, setPushNotifyInternalComments] = useState(true)
  const [pushNotifyTaskComments, setPushNotifyTaskComments] = useState(true)
  const [pushNotifyVideoApproval, setPushNotifyVideoApproval] = useState(true)
  const [pushNotifyUserAssignments, setPushNotifyUserAssignments] = useState(true)
  const [pushNotifySalesQuoteViewed, setPushNotifySalesQuoteViewed] = useState(true)
  const [pushNotifySalesQuoteAccepted, setPushNotifySalesQuoteAccepted] = useState(true)
  const [pushNotifySalesInvoiceViewed, setPushNotifySalesInvoiceViewed] = useState(true)
  const [pushNotifySalesInvoicePaid, setPushNotifySalesInvoicePaid] = useState(true)
  const [pushNotifySalesReminders, setPushNotifySalesReminders] = useState(true)
  const [pushNotifyPasswordResetRequested, setPushNotifyPasswordResetRequested] = useState(true)
  const [pushNotifyPasswordResetSuccess, setPushNotifyPasswordResetSuccess] = useState(true)

  // Collapsible section state (all collapsed by default)
  const [showCompanyBranding, setShowCompanyBranding] = useState(false)
  const [showDomainConfiguration, setShowDomainConfiguration] = useState(false)
  const [showEmailSettings, setShowEmailSettings] = useState(false)
  const [showDeveloperTools, setShowDeveloperTools] = useState(false)
  const [showVideoProcessing, setShowVideoProcessing] = useState(false)
  const [showProjectBehavior, setShowProjectBehavior] = useState(false)
  const [showPushNotifications, setShowPushNotifications] = useState(false)
  const [showDropboxStorage, setShowDropboxStorage] = useState(false)
  const [showStorageOverview, setShowStorageOverview] = useState(false)
  const [dropboxConfigured, setDropboxConfigured] = useState(false)
  const [dropboxRootPath, setDropboxRootPath] = useState('')

  // CPU Configuration state
  const [showCpuConfig, setShowCpuConfig] = useState(false)
  const [cpuDetectedThreads, setCpuDetectedThreads] = useState(0)
  const [cpuBudgetThreads, setCpuBudgetThreads] = useState(0)
  const [cpuReservedSystemThreads, setCpuReservedSystemThreads] = useState(0)
  const [cpuMaxFfmpegThreadsPerJob, setCpuMaxFfmpegThreadsPerJob] = useState(12)
  const [cpuFfmpegThreadsPerJob, setCpuFfmpegThreadsPerJob] = useState('')
  const [cpuVideoWorkerConcurrency, setCpuVideoWorkerConcurrency] = useState('')
  const [cpuDynamicThreadAllocation, setCpuDynamicThreadAllocation] = useState(true)
  const [cpuDefaultFfmpegThreadsPerJob, setCpuDefaultFfmpegThreadsPerJob] = useState(2)
  const [cpuDefaultVideoWorkerConcurrency, setCpuDefaultVideoWorkerConcurrency] = useState(1)

  const [recalcProjectDataLoading, setRecalcProjectDataLoading] = useState(false)
  const [recalcProjectDataResult, setRecalcProjectDataResult] = useState<string | null>(null)

  // Active section for desktop two-column nav
  const [activeSection, setActiveSection] = useState<typeof SETTING_SECTIONS[number]['id']>('company-branding')

  // Unsaved changes tracking
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)
  const settingsSnapshot = JSON.stringify({
    companyName, companyLogoMode, companyLogoUrl, companyFaviconMode, companyFaviconUrl,
    darkLogoEnabled, darkLogoMode, darkLogoUrl, accentColor, accentTextMode,
    emailHeaderColor, emailHeaderTextMode, defaultTheme, allowThemeToggle,
    smtpServer, smtpPort, smtpUsername, smtpPassword, emailTrackingPixelsEnabled,
    emailCustomFooterText, smtpFromAddress, smtpSecure, appDomain, mainCompanyDomain,
    defaultPreviewResolutions, defaultWatermarkEnabled, defaultTimelinePreviewsEnabled,
    defaultWatermarkText, defaultAllowClientDeleteComments, defaultAllowClientUploadFiles,
    defaultAllowAuthenticatedProjectSwitching, defaultMaxClientUploadAllocationMB,
    autoApproveProject, autoDeletePreviewsOnClose, excludeInternalIpsFromAnalytics,
    uploadChunkSizeMB, downloadChunkSizeMB, autoCloseApprovedProjectsEnabled,
    autoCloseApprovedProjectsAfterDays, adminNotificationSchedule, adminNotificationTime,
    adminNotificationDay, adminEmailProjectApproved, adminEmailInternalComments,
    adminEmailTaskComments, adminEmailInvoicePaid, adminEmailQuoteAccepted,
    adminEmailProjectKeyDates, adminEmailUserKeyDates,
    defaultClientNotificationSchedule, defaultClientNotificationTime, defaultClientNotificationDay,
    clientEmailProjectApproved, httpsEnabled, hotlinkProtection, ipRateLimit, sessionRateLimit,
    shareSessionRateLimit, shareTokenTtlSeconds, passwordAttempts, sessionTimeoutValue,
    sessionTimeoutUnit, trackAnalytics, trackSecurityLogs, viewSecurityEvents,
    maxInternalCommentsPerProject, maxCommentsPerVideoVersion, maxProjectRecipients,
    maxProjectFilesPerProject, pushEnabled,
    pushNotifyUnauthorizedOTP, pushNotifyFailedAdminLogin, pushNotifySuccessfulAdminLogin,
    pushNotifyFailedSharePasswordAttempt, pushNotifySuccessfulShareAccess,
    pushNotifyGuestVideoLinkAccess, pushNotifyClientComments, pushNotifyInternalComments,
    pushNotifyTaskComments, pushNotifyVideoApproval, pushNotifyUserAssignments,
    pushNotifySalesQuoteViewed, pushNotifySalesQuoteAccepted, pushNotifySalesInvoiceViewed,
    pushNotifySalesInvoicePaid, pushNotifySalesReminders,
    pushNotifyPasswordResetRequested, pushNotifyPasswordResetSuccess,
    cpuFfmpegThreadsPerJob, cpuVideoWorkerConcurrency, cpuDynamicThreadAllocation,
  })
  const hasUnsavedChanges = dataLoaded && savedSnapshot !== '' && settingsSnapshot !== savedSnapshot
  useUnsavedChanges(hasUnsavedChanges)

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await apiFetch('/api/settings')
        if (!response.ok) {
          throw new Error('Failed to load settings')
        }
        const data = await response.json()
        setSettings(data)

        // Set form values
        setCompanyName(data.companyName || '')
        setCompanyLogoVersion(Date.now())
        {
          const value = data.companyLogoMode
          setCompanyLogoMode(value === 'NONE' || value === 'UPLOAD' || value === 'LINK' ? value : 'NONE')
        }
        setCompanyLogoUrl(data.companyLogoUrl || '')
        setCompanyFaviconVersion(Date.now())
        {
          const value = data.companyFaviconMode
          setCompanyFaviconMode(value === 'NONE' || value === 'UPLOAD' || value === 'LINK' ? value : 'NONE')
        }
        setCompanyFaviconUrl(data.companyFaviconUrl || '')
        setDarkLogoEnabled(data.darkLogoEnabled || false)
        setDarkLogoVersion(Date.now())
        {
          const value = data.darkLogoMode
          setDarkLogoMode(value === 'NONE' || value === 'UPLOAD' || value === 'LINK' ? value : 'NONE')
        }
        setDarkLogoUrl(data.darkLogoUrl || '')
        setAccentColor(data.accentColor || '')
        setAccentTextMode(data.accentTextMode === 'DARK' ? 'DARK' : 'LIGHT')
        setEmailHeaderColor(data.emailHeaderColor || '')
        setEmailHeaderTextMode(data.emailHeaderTextMode === 'DARK' ? 'DARK' : 'LIGHT')
        setDefaultTheme(data.defaultTheme === 'LIGHT' || data.defaultTheme === 'AUTO' ? data.defaultTheme : 'DARK')
        setAllowThemeToggle(data.allowThemeToggle ?? true)
        setSmtpServer(data.smtpServer || '')
        setSmtpPort(data.smtpPort?.toString() || '587')
        setSmtpUsername(data.smtpUsername || '')
        setSmtpPassword(data.smtpPassword || '')
        setEmailTrackingPixelsEnabled(data.emailTrackingPixelsEnabled ?? true)
        setEmailCustomFooterText(data.emailCustomFooterText ?? null)
        setSmtpFromAddress(data.smtpFromAddress || '')
        setSmtpSecure(data.smtpSecure || 'STARTTLS')
        setAppDomain(data.appDomain || '')
        setMainCompanyDomain(data.mainCompanyDomain || '')
        setDefaultPreviewResolutions((() => {
          try {
            const parsed = JSON.parse(data.defaultPreviewResolutions || '["720p"]')
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['720p']
          } catch { return ['720p'] }
        })())
        setDefaultWatermarkEnabled(data.defaultWatermarkEnabled ?? true)
        setDefaultTimelinePreviewsEnabled(data.defaultTimelinePreviewsEnabled ?? false)
        setDefaultWatermarkText(data.defaultWatermarkText || '')
        setDefaultAllowClientDeleteComments(data.defaultAllowClientDeleteComments ?? false)
        setDefaultAllowClientUploadFiles(data.defaultAllowClientUploadFiles ?? false)
        setDefaultAllowAuthenticatedProjectSwitching(data.defaultAllowAuthenticatedProjectSwitching ?? true)
        setDefaultMaxClientUploadAllocationMB(data.defaultMaxClientUploadAllocationMB ?? 1000)
        setAutoApproveProject(data.autoApproveProject ?? true)
        setAutoDeletePreviewsOnClose(data.autoDeletePreviewsOnClose ?? false)
        setExcludeInternalIpsFromAnalytics(data.excludeInternalIpsFromAnalytics ?? true)
        setUploadChunkSizeMB(data.uploadChunkSizeMB ?? DEFAULT_UPLOAD_CHUNK_SIZE_MB)
        setDownloadChunkSizeMB(data.downloadChunkSizeMB ?? DEFAULT_DOWNLOAD_CHUNK_SIZE_MB)
        setAutoCloseApprovedProjectsEnabled(data.autoCloseApprovedProjectsEnabled ?? false)
        setAutoCloseApprovedProjectsAfterDays(data.autoCloseApprovedProjectsAfterDays ?? 7)
        setTestEmailAddress(data.smtpFromAddress || '')

        // Set notification settings
        setAdminNotificationSchedule(data.adminNotificationSchedule || 'HOURLY')
        setAdminNotificationTime(data.adminNotificationTime || '09:00')
        setAdminNotificationDay(data.adminNotificationDay ?? 1)
        setAdminEmailProjectApproved(data.adminEmailProjectApproved ?? true)
        setAdminEmailInternalComments(data.adminEmailInternalComments ?? true)
        setAdminEmailTaskComments(data.adminEmailTaskComments ?? true)
        setAdminEmailInvoicePaid(data.adminEmailInvoicePaid ?? true)
        setAdminEmailQuoteAccepted(data.adminEmailQuoteAccepted ?? true)
        setAdminEmailProjectKeyDates(data.adminEmailProjectKeyDates ?? true)
        setAdminEmailUserKeyDates(data.adminEmailUserKeyDates ?? true)
        setDefaultClientNotificationSchedule(data.defaultClientNotificationSchedule || 'HOURLY')
        setDefaultClientNotificationTime(data.defaultClientNotificationTime || '09:00')
        setDefaultClientNotificationDay(data.defaultClientNotificationDay ?? 1)
        setClientEmailProjectApproved(data.clientEmailProjectApproved ?? true)

        // Load security settings
        const securityResponse = await apiFetch('/api/settings/security')
        if (securityResponse.ok) {
          const securityData = await securityResponse.json()
          setSecuritySettings(securityData)

          // Set security form values
          setHttpsEnabled(securityData.httpsEnabled ?? false)
          setHotlinkProtection(securityData.hotlinkProtection || 'LOG_ONLY')
          setIpRateLimit(securityData.ipRateLimit?.toString() || '1000')
          setSessionRateLimit(securityData.sessionRateLimit?.toString() || '600')
          setShareSessionRateLimit(securityData.shareSessionRateLimit?.toString() || '300')
          setShareTokenTtlSeconds(securityData.shareTokenTtlSeconds ? securityData.shareTokenTtlSeconds.toString() : '')
          setPasswordAttempts(securityData.passwordAttempts?.toString() || '5')
          setSessionTimeoutValue(securityData.sessionTimeoutValue?.toString() || '15')
          setSessionTimeoutUnit(securityData.sessionTimeoutUnit || 'MINUTES')
          setTrackAnalytics(securityData.trackAnalytics ?? true)
          setTrackSecurityLogs(securityData.trackSecurityLogs ?? true)
          setViewSecurityEvents(securityData.viewSecurityEvents ?? false)
          setMaxInternalCommentsPerProject(securityData.maxInternalCommentsPerProject?.toString() || '250')
          setMaxCommentsPerVideoVersion(securityData.maxCommentsPerVideoVersion?.toString() || '100')
          setMaxProjectRecipients(securityData.maxProjectRecipients?.toString() || '30')
          setMaxProjectFilesPerProject(securityData.maxProjectFilesPerProject?.toString() || '50')
        }

        // Load push notification settings
        const pushResponse = await apiFetch('/api/settings/push-notifications')
        if (!pushResponse.ok) {
          const pushErr = await pushResponse
            .json()
            .catch(() => ({ error: 'Failed to load push notification settings' }))
          setError(pushErr.error || 'Failed to load push notification settings')
        } else {
          const pushData = await pushResponse.json()

          // Set push notification form values
          setPushEnabled(pushData.enabled ?? false)
          setPushNotifyUnauthorizedOTP(pushData.notifyUnauthorizedOTP ?? true)
          setPushNotifyFailedAdminLogin(pushData.notifyFailedAdminLogin ?? true)
          setPushNotifySuccessfulAdminLogin(pushData.notifySuccessfulAdminLogin ?? true)
          setPushNotifyFailedSharePasswordAttempt(pushData.notifyFailedSharePasswordAttempt ?? true)
          setPushNotifySuccessfulShareAccess(pushData.notifySuccessfulShareAccess ?? true)
          setPushNotifyGuestVideoLinkAccess(pushData.notifyGuestVideoLinkAccess ?? true)
          setPushNotifyClientComments(pushData.notifyClientComments ?? true)
          setPushNotifyInternalComments(pushData.notifyInternalComments ?? true)
          setPushNotifyTaskComments(pushData.notifyTaskComments ?? true)
          setPushNotifyVideoApproval(pushData.notifyVideoApproval ?? true)
          setPushNotifyUserAssignments(pushData.notifyUserAssignments ?? true)
          setPushNotifySalesQuoteViewed(pushData.notifySalesQuoteViewed ?? true)
          setPushNotifySalesQuoteAccepted(pushData.notifySalesQuoteAccepted ?? true)
          setPushNotifySalesInvoiceViewed(pushData.notifySalesInvoiceViewed ?? true)
          setPushNotifySalesInvoicePaid(pushData.notifySalesInvoicePaid ?? true)
          setPushNotifySalesReminders(pushData.notifySalesReminders ?? true)
          setPushNotifyPasswordResetRequested(pushData.notifyPasswordResetRequested ?? true)
          setPushNotifyPasswordResetSuccess(pushData.notifyPasswordResetSuccess ?? true)
        }

        // Load CPU configuration
        const cpuResponse = await apiFetch('/api/settings/cpu')
        if (cpuResponse.ok) {
          const cpuData = await cpuResponse.json()
          setCpuDetectedThreads(cpuData.system?.detectedThreads || 0)
          setCpuBudgetThreads(cpuData.system?.budgetThreads || 0)
          setCpuReservedSystemThreads(cpuData.system?.reservedSystemThreads || 0)
          setCpuMaxFfmpegThreadsPerJob(cpuData.system?.maxFfmpegThreadsPerJob || 12)
          setCpuDefaultFfmpegThreadsPerJob(cpuData.current?.ffmpegThreadsPerJob || 2)
          setCpuDefaultVideoWorkerConcurrency(cpuData.current?.videoWorkerConcurrency || 1)
          setCpuFfmpegThreadsPerJob(
            cpuData.overrides?.ffmpegThreadsPerJob != null
              ? String(cpuData.overrides.ffmpegThreadsPerJob)
              : ''
          )
          setCpuVideoWorkerConcurrency(
            cpuData.overrides?.videoWorkerConcurrency != null
              ? String(cpuData.overrides.videoWorkerConcurrency)
              : ''
          )
          setCpuDynamicThreadAllocation(
            cpuData.overrides?.dynamicThreadAllocation != null
              ? cpuData.overrides.dynamicThreadAllocation
              : cpuData.current?.dynamicThreadAllocation ?? true
          )
        }

        // Dropbox status is included in the main settings response
        if (data.dropboxConfigured !== undefined) {
          setDropboxConfigured(data.dropboxConfigured)
          setDropboxRootPath(data.dropboxRootPath || '')
        }
      } catch (err) {
        setError('Failed to load settings')
      } finally {
        setLoading(false)
        setDataLoaded(true)
      }
    }

    loadSettings()
  }, [])

  // Set initial snapshot after data loads and all state has settled
  useEffect(() => {
    if (dataLoaded && savedSnapshot === '') {
      setSavedSnapshot(settingsSnapshot)
    }
  }, [dataLoaded, savedSnapshot, settingsSnapshot])

  const loadBlocklists = async () => {
    setBlocklistsLoading(true)
    try {
      const [ipsResponse, domainsResponse] = await Promise.all([
        apiFetch('/api/security/blocklist/ips'),
        apiFetch('/api/security/blocklist/domains')
      ])

      if (ipsResponse.ok) {
        const ipsData = await ipsResponse.json()
        setBlockedIPs(ipsData.blockedIPs || [])
      }

      if (domainsResponse.ok) {
        const domainsData = await domainsResponse.json()
        setBlockedDomains(domainsData.blockedDomains || [])
      }
    } catch (err) {
      // keep prior state on failure
    } finally {
      setBlocklistsLoading(false)
    }
  }

  useEffect(() => {
    if (showSecuritySettings) {
      loadBlocklists()
    }
  }, [showSecuritySettings])

  function handleSectionChange(sectionId: typeof SETTING_SECTIONS[number]['id']) {
    setActiveSection(sectionId)
    if (sectionId === 'security') {
      loadBlocklists()
    }
  }

  const handleAddIP = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newIP.trim()) return

    try {
      const response = await apiFetch('/api/security/blocklist/ips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ipAddress: newIP.trim(), reason: newIPReason.trim() || null })
      })

      if (!response.ok) {
        const error = await response.json()
        setError(error.error || 'Failed to block IP')
        return
      }

      setNewIP('')
      setNewIPReason('')
      loadBlocklists()
    } catch {
      setError('Failed to block IP address')
    }
  }

  const handleRemoveIP = async (id: string) => {
    if (!confirm('Remove this IP from blocklist?')) return

    try {
      await apiFetch('/api/security/blocklist/ips', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })

      loadBlocklists()
    } catch {
      setError('Failed to remove IP from blocklist')
    }
  }

  const handleAddDomain = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newDomain.trim()) return

    try {
      const response = await apiFetch('/api/security/blocklist/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: newDomain.trim(), reason: newDomainReason.trim() || null })
      })

      if (!response.ok) {
        const error = await response.json()
        setError(error.error || 'Failed to block domain')
        return
      }

      setNewDomain('')
      setNewDomainReason('')
      loadBlocklists()
    } catch {
      setError('Failed to block domain')
    }
  }

  const handleRemoveDomain = async (id: string) => {
    if (!confirm('Remove this domain from blocklist?')) return

    try {
      await apiFetch('/api/security/blocklist/domains', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })

      loadBlocklists()
    } catch {
      setError('Failed to remove domain from blocklist')
    }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    setSuccess(false)

    try {
      const parsedCpuThreadsPerJob = cpuFfmpegThreadsPerJob.trim()
        ? parseInt(cpuFfmpegThreadsPerJob, 10)
        : cpuDefaultFfmpegThreadsPerJob
      const parsedCpuConcurrency = cpuVideoWorkerConcurrency.trim()
        ? parseInt(cpuVideoWorkerConcurrency, 10)
        : cpuDefaultVideoWorkerConcurrency

      if (!Number.isFinite(parsedCpuThreadsPerJob) || parsedCpuThreadsPerJob < 1 || parsedCpuThreadsPerJob > cpuMaxFfmpegThreadsPerJob) {
        throw new Error(`FFmpeg threads per job must be between 1 and ${cpuMaxFfmpegThreadsPerJob}.`)
      }

      if (!Number.isFinite(parsedCpuConcurrency) || parsedCpuConcurrency < 1 || parsedCpuConcurrency > 20) {
        throw new Error('Concurrent jobs must be between 1 and 20.')
      }

      const parsedUploadChunkSizeMB = typeof uploadChunkSizeMB === 'number'
        ? uploadChunkSizeMB
        : parseInt(String(uploadChunkSizeMB), 10)
      const parsedDownloadChunkSizeMB = typeof downloadChunkSizeMB === 'number'
        ? downloadChunkSizeMB
        : parseInt(String(downloadChunkSizeMB), 10)

      if (!Number.isInteger(parsedUploadChunkSizeMB) || parsedUploadChunkSizeMB < MIN_UPLOAD_CHUNK_SIZE_MB || parsedUploadChunkSizeMB > MAX_UPLOAD_CHUNK_SIZE_MB) {
        throw new Error(`Upload chunk size must be between ${MIN_UPLOAD_CHUNK_SIZE_MB} and ${MAX_UPLOAD_CHUNK_SIZE_MB} MB.`)
      }

      if (!Number.isInteger(parsedDownloadChunkSizeMB) || parsedDownloadChunkSizeMB < MIN_DOWNLOAD_CHUNK_SIZE_MB || parsedDownloadChunkSizeMB > MAX_DOWNLOAD_CHUNK_SIZE_MB) {
        throw new Error(`Download chunk size must be between ${MIN_DOWNLOAD_CHUNK_SIZE_MB} and ${MAX_DOWNLOAD_CHUNK_SIZE_MB} MB.`)
      }

      const estimatedCpuThreads = parsedCpuThreadsPerJob * parsedCpuConcurrency
      if (cpuDetectedThreads > 0 && estimatedCpuThreads > cpuDetectedThreads) {
        throw new Error(
          `CPU Configuration would use ${estimatedCpuThreads} threads, which exceeds the detected system limit of ${cpuDetectedThreads}. Reduce FFmpeg threads per job or concurrent jobs.`
        )
      }

      const updates = {
        companyName: companyName || null,
        companyLogoMode: companyLogoMode || 'NONE',
        companyLogoUrl: companyLogoMode === 'LINK' ? (companyLogoUrl || null) : null,
        companyFaviconMode: companyFaviconMode || 'NONE',
        companyFaviconUrl: companyFaviconMode === 'LINK' ? (companyFaviconUrl || null) : null,
        darkLogoEnabled,
        darkLogoMode: darkLogoEnabled ? (darkLogoMode || 'NONE') : 'NONE',
        darkLogoUrl: darkLogoEnabled && darkLogoMode === 'LINK' ? (darkLogoUrl || null) : null,
        accentColor: accentColor.trim() || null,
        accentTextMode,
        emailHeaderColor: emailHeaderColor.trim() || null,
        emailHeaderTextMode,
        defaultTheme,
        allowThemeToggle,
        smtpServer: smtpServer || null,
        smtpPort: smtpPort ? parseInt(smtpPort, 10) : 587,
        smtpUsername: smtpUsername || null,
        smtpPassword: smtpPassword || null,
        emailTrackingPixelsEnabled,
        emailCustomFooterText,
        smtpFromAddress: smtpFromAddress || null,
        smtpSecure: smtpSecure || 'STARTTLS',
        appDomain: appDomain || null,
        mainCompanyDomain: mainCompanyDomain || null,
        defaultPreviewResolutions: defaultPreviewResolutions.length > 0 ? defaultPreviewResolutions : ['720p'],
        defaultWatermarkEnabled: defaultWatermarkEnabled,
        defaultTimelinePreviewsEnabled: defaultTimelinePreviewsEnabled,
        defaultWatermarkText: defaultWatermarkText || null,
        defaultAllowClientDeleteComments,
        defaultAllowClientUploadFiles,
        defaultAllowAuthenticatedProjectSwitching,
        defaultMaxClientUploadAllocationMB: typeof defaultMaxClientUploadAllocationMB === 'number'
          ? defaultMaxClientUploadAllocationMB
          : parseInt(String(defaultMaxClientUploadAllocationMB), 10) || 0,
        autoApproveProject: autoApproveProject,
        autoDeletePreviewsOnClose: autoDeletePreviewsOnClose,
        excludeInternalIpsFromAnalytics,
        uploadChunkSizeMB: parsedUploadChunkSizeMB,
        downloadChunkSizeMB: parsedDownloadChunkSizeMB,
        autoCloseApprovedProjectsEnabled: autoCloseApprovedProjectsEnabled,
        autoCloseApprovedProjectsAfterDays: typeof autoCloseApprovedProjectsAfterDays === 'number'
          ? autoCloseApprovedProjectsAfterDays
          : parseInt(String(autoCloseApprovedProjectsAfterDays), 10) || 7,
        adminNotificationSchedule: adminNotificationSchedule,
        adminNotificationTime: adminNotificationSchedule === 'DAILY' ? adminNotificationTime : null,
        adminNotificationDay: null,
        adminEmailProjectApproved,
        adminEmailInternalComments,
        adminEmailTaskComments,
        adminEmailInvoicePaid,
        adminEmailQuoteAccepted,
        adminEmailProjectKeyDates,
        adminEmailUserKeyDates,
        defaultClientNotificationSchedule,
        defaultClientNotificationTime: defaultClientNotificationSchedule === 'DAILY' ? defaultClientNotificationTime : null,
        defaultClientNotificationDay: null,
        clientEmailProjectApproved,
      }

      // Save global settings
      await apiPatch('/api/settings', updates)

      // Save security settings
      const securityUpdates = {
        hotlinkProtection,
        ipRateLimit: parseInt(ipRateLimit, 10) || 1000,
        sessionRateLimit: parseInt(sessionRateLimit, 10) || 600,
        shareSessionRateLimit: parseInt(shareSessionRateLimit, 10) || 300,
        shareTokenTtlSeconds: shareTokenTtlSeconds ? parseInt(shareTokenTtlSeconds, 10) : null,
        passwordAttempts: parseInt(passwordAttempts, 10) || 5,
        sessionTimeoutValue: parseInt(sessionTimeoutValue, 10) || 15,
        sessionTimeoutUnit: sessionTimeoutUnit || 'MINUTES',
        trackAnalytics,
        trackSecurityLogs,
        viewSecurityEvents,
        maxInternalCommentsPerProject: parseInt(maxInternalCommentsPerProject, 10) || 250,
        maxCommentsPerVideoVersion: parseInt(maxCommentsPerVideoVersion, 10) || 100,
        maxProjectRecipients: parseInt(maxProjectRecipients, 10) || 30,
        maxProjectFilesPerProject: parseInt(maxProjectFilesPerProject, 10) || 50,
      }

      await apiPatch('/api/settings/security', securityUpdates)

      // Save push notification settings
      const pushUpdates = {
        enabled: pushEnabled,
        notifyUnauthorizedOTP: pushNotifyUnauthorizedOTP,
        notifyFailedAdminLogin: pushNotifyFailedAdminLogin,
        notifySuccessfulAdminLogin: pushNotifySuccessfulAdminLogin,
        notifyFailedSharePasswordAttempt: pushNotifyFailedSharePasswordAttempt,
        notifySuccessfulShareAccess: pushNotifySuccessfulShareAccess,
        notifyGuestVideoLinkAccess: pushNotifyGuestVideoLinkAccess,
        notifyClientComments: pushNotifyClientComments,
        notifyInternalComments: pushNotifyInternalComments,
        notifyTaskComments: pushNotifyTaskComments,
        notifyVideoApproval: pushNotifyVideoApproval,
        notifyUserAssignments: pushNotifyUserAssignments,
        notifySalesQuoteViewed: pushNotifySalesQuoteViewed,
        notifySalesQuoteAccepted: pushNotifySalesQuoteAccepted,
        notifySalesInvoiceViewed: pushNotifySalesInvoiceViewed,
        notifySalesInvoicePaid: pushNotifySalesInvoicePaid,
        notifySalesReminders: pushNotifySalesReminders,
        notifyPasswordResetRequested: pushNotifyPasswordResetRequested,
        notifyPasswordResetSuccess: pushNotifyPasswordResetSuccess,
      }

      await apiPatch('/api/settings/push-notifications', pushUpdates)

      // Save CPU configuration
      const cpuUpdates: Record<string, any> = {
        dynamicThreadAllocation: cpuDynamicThreadAllocation,
      }
      if (cpuFfmpegThreadsPerJob.trim()) {
        cpuUpdates.ffmpegThreadsPerJob = parseInt(cpuFfmpegThreadsPerJob, 10)
      } else {
        cpuUpdates.ffmpegThreadsPerJob = null
      }
      if (cpuVideoWorkerConcurrency.trim()) {
        cpuUpdates.videoWorkerConcurrency = parseInt(cpuVideoWorkerConcurrency, 10)
      } else {
        cpuUpdates.videoWorkerConcurrency = null
      }

      await apiPatch('/api/settings/cpu', cpuUpdates)

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)

      // Reset unsaved changes tracking
      setSavedSnapshot('')

      // Reload settings data to reflect changes
      const refreshResponse = await apiFetch('/api/settings')
      if (refreshResponse.ok) {
        const refreshedData = await refreshResponse.json()
        setSettings(refreshedData)
        // Update form state with refreshed data
        setCompanyName(refreshedData.companyName || '')
        setCompanyLogoMode((refreshedData.companyLogoMode as any) || 'NONE')
        setCompanyLogoUrl(refreshedData.companyLogoUrl || '')
        setCompanyFaviconMode((refreshedData.companyFaviconMode as any) || 'NONE')
        setCompanyFaviconUrl(refreshedData.companyFaviconUrl || '')
        setDarkLogoEnabled(refreshedData.darkLogoEnabled || false)
        setDarkLogoMode((refreshedData.darkLogoMode as any) || 'NONE')
        setDarkLogoUrl(refreshedData.darkLogoUrl || '')
        setSmtpServer(refreshedData.smtpServer || '')
        setSmtpPort(refreshedData.smtpPort?.toString() || '587')
        setSmtpUsername(refreshedData.smtpUsername || '')
        setSmtpPassword(refreshedData.smtpPassword || '')
        setEmailTrackingPixelsEnabled(refreshedData.emailTrackingPixelsEnabled ?? true)
        setEmailCustomFooterText(refreshedData.emailCustomFooterText ?? null)
        setSmtpFromAddress(refreshedData.smtpFromAddress || '')
        setSmtpSecure(refreshedData.smtpSecure || 'STARTTLS')
        setAppDomain(refreshedData.appDomain || '')
        setMainCompanyDomain(refreshedData.mainCompanyDomain || '')
        setDefaultPreviewResolutions((() => {
          try {
            const parsed = JSON.parse(refreshedData.defaultPreviewResolutions || '["720p"]')
            return Array.isArray(parsed) && parsed.length > 0 ? parsed : ['720p']
          } catch { return ['720p'] }
        })())
        setDefaultWatermarkEnabled(refreshedData.defaultWatermarkEnabled ?? true)
        setDefaultTimelinePreviewsEnabled(refreshedData.defaultTimelinePreviewsEnabled ?? false)
        setDefaultWatermarkText(refreshedData.defaultWatermarkText || '')
        setDefaultAllowClientDeleteComments(refreshedData.defaultAllowClientDeleteComments ?? false)
        setDefaultAllowClientUploadFiles(refreshedData.defaultAllowClientUploadFiles ?? false)
        setDefaultAllowAuthenticatedProjectSwitching(refreshedData.defaultAllowAuthenticatedProjectSwitching ?? true)
        setDefaultMaxClientUploadAllocationMB(refreshedData.defaultMaxClientUploadAllocationMB ?? 1000)
        setAutoApproveProject(refreshedData.autoApproveProject ?? true)
        setExcludeInternalIpsFromAnalytics(refreshedData.excludeInternalIpsFromAnalytics ?? true)
        setUploadChunkSizeMB(refreshedData.uploadChunkSizeMB ?? DEFAULT_UPLOAD_CHUNK_SIZE_MB)
        setDownloadChunkSizeMB(refreshedData.downloadChunkSizeMB ?? DEFAULT_DOWNLOAD_CHUNK_SIZE_MB)
        setAutoCloseApprovedProjectsEnabled(refreshedData.autoCloseApprovedProjectsEnabled ?? false)
        setAutoCloseApprovedProjectsAfterDays(refreshedData.autoCloseApprovedProjectsAfterDays ?? 7)
        setAutoDeletePreviewsOnClose(refreshedData.autoDeletePreviewsOnClose ?? false)
        setAdminNotificationSchedule(refreshedData.adminNotificationSchedule || 'HOURLY')
        setAdminNotificationTime(refreshedData.adminNotificationTime || '09:00')
        setAdminNotificationDay(refreshedData.adminNotificationDay ?? 1)
        setAdminEmailProjectApproved(refreshedData.adminEmailProjectApproved ?? true)
        setAdminEmailInternalComments(refreshedData.adminEmailInternalComments ?? true)
        setAdminEmailTaskComments(refreshedData.adminEmailTaskComments ?? true)
        setAdminEmailInvoicePaid(refreshedData.adminEmailInvoicePaid ?? true)
        setAdminEmailQuoteAccepted(refreshedData.adminEmailQuoteAccepted ?? true)
        setAdminEmailProjectKeyDates(refreshedData.adminEmailProjectKeyDates ?? true)
        setAdminEmailUserKeyDates(refreshedData.adminEmailUserKeyDates ?? true)
        setDefaultClientNotificationSchedule(refreshedData.defaultClientNotificationSchedule || 'HOURLY')
        setDefaultClientNotificationTime(refreshedData.defaultClientNotificationTime || '09:00')
        setDefaultClientNotificationDay(refreshedData.defaultClientNotificationDay ?? 1)
        setClientEmailProjectApproved(refreshedData.clientEmailProjectApproved ?? true)
      }

      // Reload security settings data
      const securityRefreshResponse = await apiFetch('/api/settings/security')
      if (securityRefreshResponse.ok) {
        const refreshedSecurityData = await securityRefreshResponse.json()
        setSecuritySettings(refreshedSecurityData)
        // Update form state with refreshed data
        setHttpsEnabled(refreshedSecurityData.httpsEnabled)
        setHotlinkProtection(refreshedSecurityData.hotlinkProtection)
        setIpRateLimit(refreshedSecurityData.ipRateLimit?.toString() || '1000')
        setSessionRateLimit(refreshedSecurityData.sessionRateLimit?.toString() || '600')
        setPasswordAttempts(refreshedSecurityData.passwordAttempts?.toString() || '5')
        setSessionTimeoutValue(refreshedSecurityData.sessionTimeoutValue?.toString() || '15')
        setSessionTimeoutUnit(refreshedSecurityData.sessionTimeoutUnit || 'MINUTES')
        setTrackAnalytics(refreshedSecurityData.trackAnalytics)
        setTrackSecurityLogs(refreshedSecurityData.trackSecurityLogs)
        setViewSecurityEvents(refreshedSecurityData.viewSecurityEvents)
        setMaxInternalCommentsPerProject(refreshedSecurityData.maxInternalCommentsPerProject?.toString() || '250')
        setMaxCommentsPerVideoVersion(refreshedSecurityData.maxCommentsPerVideoVersion?.toString() || '100')
        setMaxProjectRecipients(refreshedSecurityData.maxProjectRecipients?.toString() || '30')
        setMaxProjectFilesPerProject(refreshedSecurityData.maxProjectFilesPerProject?.toString() || '50')
      }

      // Refresh the page to update server components (like AdminHeader menu)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  async function handleTestEmail() {
    setTestEmailSending(true)
    setTestEmailResult(null)

    try {
      // Prepare current form values as SMTP config
      const smtpConfig = {
        smtpServer: smtpServer || null,
        smtpPort: smtpPort ? parseInt(smtpPort, 10) : null,
        smtpUsername: smtpUsername || null,
        smtpPassword: smtpPassword || null,
        smtpFromAddress: smtpFromAddress || null,
        smtpSecure: smtpSecure || 'STARTTLS',
        companyName: companyName || 'ViTransfer',
        appDomain: appDomain || null,
        companyLogoMode,
        companyLogoUrl: companyLogoMode === 'LINK' ? (companyLogoUrl || null) : null,
      }

      // Validate that all required fields are filled
      if (!smtpConfig.smtpServer || !smtpConfig.smtpPort || !smtpConfig.smtpUsername ||
          !smtpConfig.smtpPassword || !smtpConfig.smtpFromAddress) {
        setTestEmailResult({
          type: 'error',
          message: 'Please fill in all SMTP fields before testing'
        })
        setTestEmailSending(false)
        return
      }

      const data = await apiPost('/api/settings/test-email', {
        testEmail: testEmailAddress,
        smtpConfig: smtpConfig
      })

      setTestEmailResult({
        type: 'success',
        message: data.message || 'Test email sent successfully! Check your inbox.'
      })
    } catch (error) {
      setTestEmailResult({
        type: 'error',
        message: 'Failed to send test email'
      })
    } finally {
      setTestEmailSending(false)
    }
  }

  async function handleRecalculateProjectDataTotals() {
    setRecalcProjectDataLoading(true)
    setRecalcProjectDataResult(null)

    try {
      const res = await apiPost('/api/settings/reconcile-project-data', {})

      if (res?.ranInline) {
        setRecalcProjectDataResult('Recalculation completed.')
      } else if (res?.alreadyQueued) {
        setRecalcProjectDataResult('Already queued. Check back shortly.')
      } else {
        setRecalcProjectDataResult('Queued. Worker will update totals shortly.')
      }
    } catch (e: any) {
      setRecalcProjectDataResult(e?.message || 'Failed to start recalculation')
    } finally {
      setRecalcProjectDataLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="mb-4 sm:mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
                <SettingsIcon className="w-7 h-7 sm:w-8 sm:h-8" />
                Global Settings
              </h1>
              <p className="text-sm sm:text-base text-muted-foreground mt-1">
                Configure application-wide settings
              </p>
              <div className="mt-2 text-xs text-muted-foreground">
                Powered by <span className="font-medium text-foreground">ViTransfer</span>
                {appVersion ? (
                  <span className="ml-2 rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide">
                    Version {appVersion}
                  </span>
                ) : null}
              </div>
            </div>

            <Button onClick={handleSave} variant="default" disabled={saving} size="lg" className="w-full sm:w-auto">
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
          <CompanyBrandingSection
            companyName={companyName}
            setCompanyName={setCompanyName}
            companyLogoMode={companyLogoMode}
            setCompanyLogoMode={setCompanyLogoMode}
            companyLogoLinkUrl={companyLogoUrl}
            setCompanyLogoLinkUrl={setCompanyLogoUrl}
            companyLogoConfigured={companyLogoMode === 'UPLOAD' && !!settings?.companyLogoPath}
            companyLogoUrl={
              companyLogoMode === 'UPLOAD'
                ? (settings?.companyLogoPath ? `/api/branding/logo?v=${companyLogoVersion}` : null)
                : (companyLogoMode === 'LINK' ? (companyLogoUrl || null) : null)
            }
            darkLogoEnabled={darkLogoEnabled}
            setDarkLogoEnabled={setDarkLogoEnabled}
            darkLogoMode={darkLogoMode}
            setDarkLogoMode={setDarkLogoMode}
            darkLogoLinkUrl={darkLogoUrl}
            setDarkLogoLinkUrl={setDarkLogoUrl}
            darkLogoConfigured={darkLogoMode === 'UPLOAD' && !!settings?.darkLogoPath}
            darkLogoUrl={
              darkLogoMode === 'UPLOAD'
                ? (settings?.darkLogoPath ? `/api/branding/dark-logo?v=${darkLogoVersion}` : null)
                : (darkLogoMode === 'LINK' ? (darkLogoUrl || null) : null)
            }
            onDarkLogoUploaded={() => {
              setDarkLogoVersion(Date.now())
              apiFetch('/api/settings')
                .then((r) => r.ok ? r.json() : null)
                .then((d) => {
                  if (!d) return
                  setSettings(d)
                  setDarkLogoEnabled(!!d.darkLogoEnabled)
                  setDarkLogoMode((d.darkLogoMode as any) || 'NONE')
                  setDarkLogoUrl(d.darkLogoUrl || '')
                })
                .catch(() => {})
            }}
            companyFaviconMode={companyFaviconMode}
            setCompanyFaviconMode={setCompanyFaviconMode}
            companyFaviconLinkUrl={companyFaviconUrl}
            setCompanyFaviconLinkUrl={setCompanyFaviconUrl}
            companyFaviconConfigured={companyFaviconMode === 'UPLOAD' && !!settings?.companyFaviconPath}
            companyFaviconUrl={
              companyFaviconMode === 'UPLOAD'
                ? (settings?.companyFaviconPath ? `/api/branding/favicon?v=${companyFaviconVersion}` : null)
                : (companyFaviconMode === 'LINK' ? (companyFaviconUrl || null) : null)
            }
            onCompanyLogoUploaded={() => {
              setCompanyLogoVersion(Date.now())
              setCompanyFaviconVersion(Date.now())
              // Force settings refresh so other parts relying on settings stay accurate
              apiFetch('/api/settings')
                .then((r) => r.ok ? r.json() : null)
                .then((d) => {
                  if (!d) return
                  setSettings(d)
                  setCompanyLogoMode((d.companyLogoMode as any) || 'NONE')
                  setCompanyLogoUrl(d.companyLogoUrl || '')
                  setCompanyFaviconMode((d.companyFaviconMode as any) || 'NONE')
                  setCompanyFaviconUrl(d.companyFaviconUrl || '')
                  setDarkLogoEnabled(!!d.darkLogoEnabled)
                  setDarkLogoMode((d.darkLogoMode as any) || 'NONE')
                  setDarkLogoUrl(d.darkLogoUrl || '')
                })
                .catch(() => {})
            }}
            onCompanyFaviconUploaded={() => {
              setCompanyFaviconVersion(Date.now())
              // Force settings refresh so other parts relying on settings stay accurate
              apiFetch('/api/settings')
                .then((r) => r.ok ? r.json() : null)
                .then((d) => {
                  if (!d) return
                  setSettings(d)
                  setCompanyFaviconMode((d.companyFaviconMode as any) || 'NONE')
                  setCompanyFaviconUrl(d.companyFaviconUrl || '')
                })
                .catch(() => {})
            }}
            accentColor={accentColor}
            setAccentColor={setAccentColor}
            accentTextMode={accentTextMode}
            setAccentTextMode={setAccentTextMode}
            emailHeaderColor={emailHeaderColor}
            setEmailHeaderColor={setEmailHeaderColor}
            emailHeaderTextMode={emailHeaderTextMode}
            setEmailHeaderTextMode={setEmailHeaderTextMode}
            defaultTheme={defaultTheme}
            setDefaultTheme={setDefaultTheme}
            allowThemeToggle={allowThemeToggle}
            setAllowThemeToggle={setAllowThemeToggle}
            show={showCompanyBranding}
            setShow={setShowCompanyBranding}
          />

          <DomainConfigurationSection
            appDomain={appDomain}
            setAppDomain={setAppDomain}
            mainCompanyDomain={mainCompanyDomain}
            setMainCompanyDomain={setMainCompanyDomain}
            show={showDomainConfiguration}
            setShow={setShowDomainConfiguration}
          />

          <EmailSettingsSection
            smtpServer={smtpServer}
            setSmtpServer={setSmtpServer}
            smtpPort={smtpPort}
            setSmtpPort={setSmtpPort}
            smtpUsername={smtpUsername}
            setSmtpUsername={setSmtpUsername}
            smtpPassword={smtpPassword}
            setSmtpPassword={setSmtpPassword}
            emailTrackingPixelsEnabled={emailTrackingPixelsEnabled}
            setEmailTrackingPixelsEnabled={setEmailTrackingPixelsEnabled}
            emailCustomFooterText={emailCustomFooterText}
            setEmailCustomFooterText={setEmailCustomFooterText}
            smtpFromAddress={smtpFromAddress}
            setSmtpFromAddress={setSmtpFromAddress}
            smtpSecure={smtpSecure}
            setSmtpSecure={setSmtpSecure}
            testEmailAddress={testEmailAddress}
            setTestEmailAddress={setTestEmailAddress}
            testEmailSending={testEmailSending}
            testEmailResult={testEmailResult}
            handleTestEmail={handleTestEmail}
            adminNotificationSchedule={adminNotificationSchedule}
            setAdminNotificationSchedule={setAdminNotificationSchedule}
            adminNotificationTime={adminNotificationTime}
            setAdminNotificationTime={setAdminNotificationTime}
            adminNotificationDay={adminNotificationDay}
            setAdminNotificationDay={setAdminNotificationDay}
            adminEmailProjectApproved={adminEmailProjectApproved}
            setAdminEmailProjectApproved={setAdminEmailProjectApproved}
            adminEmailInternalComments={adminEmailInternalComments}
            setAdminEmailInternalComments={setAdminEmailInternalComments}
            adminEmailTaskComments={adminEmailTaskComments}
            setAdminEmailTaskComments={setAdminEmailTaskComments}
            adminEmailInvoicePaid={adminEmailInvoicePaid}
            setAdminEmailInvoicePaid={setAdminEmailInvoicePaid}
            adminEmailQuoteAccepted={adminEmailQuoteAccepted}
            setAdminEmailQuoteAccepted={setAdminEmailQuoteAccepted}
            adminEmailProjectKeyDates={adminEmailProjectKeyDates}
            setAdminEmailProjectKeyDates={setAdminEmailProjectKeyDates}
            adminEmailUserKeyDates={adminEmailUserKeyDates}
            setAdminEmailUserKeyDates={setAdminEmailUserKeyDates}
            show={showEmailSettings}
            setShow={setShowEmailSettings}
          />

          <CpuConfigurationSection
            show={showCpuConfig}
            setShow={setShowCpuConfig}
            detectedThreads={cpuDetectedThreads}
            budgetThreads={cpuBudgetThreads}
            reservedSystemThreads={cpuReservedSystemThreads}
            maxFfmpegThreadsPerJob={cpuMaxFfmpegThreadsPerJob}
            ffmpegThreadsPerJob={cpuFfmpegThreadsPerJob}
            setFfmpegThreadsPerJob={setCpuFfmpegThreadsPerJob}
            videoWorkerConcurrency={cpuVideoWorkerConcurrency}
            setVideoWorkerConcurrency={setCpuVideoWorkerConcurrency}
            dynamicThreadAllocation={cpuDynamicThreadAllocation}
            setDynamicThreadAllocation={setCpuDynamicThreadAllocation}
            defaultFfmpegThreadsPerJob={cpuDefaultFfmpegThreadsPerJob}
            defaultVideoWorkerConcurrency={cpuDefaultVideoWorkerConcurrency}
          />

          <StorageOverviewSection
            show={showStorageOverview}
            setShow={setShowStorageOverview}
            autoDeletePreviewsOnClose={autoDeletePreviewsOnClose}
            setAutoDeletePreviewsOnClose={setAutoDeletePreviewsOnClose}
            onRecalculateProjectDataTotals={handleRecalculateProjectDataTotals}
            recalculateProjectDataTotalsLoading={recalcProjectDataLoading}
            recalculateProjectDataTotalsResult={recalcProjectDataResult}
          />

          <DropboxStorageSection
            show={showDropboxStorage}
            setShow={setShowDropboxStorage}
            dropboxConfigured={dropboxConfigured}
            dropboxRootPath={dropboxRootPath}
          />

          <VideoProcessingSettingsSection
            defaultPreviewResolutions={defaultPreviewResolutions}
            setDefaultPreviewResolutions={setDefaultPreviewResolutions}
            defaultWatermarkEnabled={defaultWatermarkEnabled}
            setDefaultWatermarkEnabled={setDefaultWatermarkEnabled}
            defaultTimelinePreviewsEnabled={defaultTimelinePreviewsEnabled}
            setDefaultTimelinePreviewsEnabled={setDefaultTimelinePreviewsEnabled}
            defaultWatermarkText={defaultWatermarkText}
            setDefaultWatermarkText={setDefaultWatermarkText}
            defaultAllowClientDeleteComments={defaultAllowClientDeleteComments}
            setDefaultAllowClientDeleteComments={setDefaultAllowClientDeleteComments}
            defaultAllowClientUploadFiles={defaultAllowClientUploadFiles}
            setDefaultAllowClientUploadFiles={setDefaultAllowClientUploadFiles}
            defaultAllowAuthenticatedProjectSwitching={defaultAllowAuthenticatedProjectSwitching}
            setDefaultAllowAuthenticatedProjectSwitching={setDefaultAllowAuthenticatedProjectSwitching}
            defaultMaxClientUploadAllocationMB={defaultMaxClientUploadAllocationMB}
            setDefaultMaxClientUploadAllocationMB={setDefaultMaxClientUploadAllocationMB}
            defaultClientNotificationSchedule={defaultClientNotificationSchedule}
            setDefaultClientNotificationSchedule={setDefaultClientNotificationSchedule}
            defaultClientNotificationTime={defaultClientNotificationTime}
            setDefaultClientNotificationTime={setDefaultClientNotificationTime}
            defaultClientNotificationDay={defaultClientNotificationDay}
            setDefaultClientNotificationDay={setDefaultClientNotificationDay}
            clientEmailProjectApproved={clientEmailProjectApproved}
            setClientEmailProjectApproved={setClientEmailProjectApproved}
            show={showVideoProcessing}
            setShow={setShowVideoProcessing}
          />

          <ProjectBehaviorSection
            autoApproveProject={autoApproveProject}
            setAutoApproveProject={setAutoApproveProject}
            autoCloseApprovedProjectsEnabled={autoCloseApprovedProjectsEnabled}
            setAutoCloseApprovedProjectsEnabled={setAutoCloseApprovedProjectsEnabled}
            autoCloseApprovedProjectsAfterDays={autoCloseApprovedProjectsAfterDays}
            setAutoCloseApprovedProjectsAfterDays={setAutoCloseApprovedProjectsAfterDays}
            show={showProjectBehavior}
            setShow={setShowProjectBehavior}
          />

          <DeveloperToolsSection
            excludeInternalIpsFromAnalytics={excludeInternalIpsFromAnalytics}
            setExcludeInternalIpsFromAnalytics={setExcludeInternalIpsFromAnalytics}
            uploadChunkSizeMB={uploadChunkSizeMB}
            setUploadChunkSizeMB={setUploadChunkSizeMB}
            downloadChunkSizeMB={downloadChunkSizeMB}
            setDownloadChunkSizeMB={setDownloadChunkSizeMB}
            show={showDeveloperTools}
            setShow={setShowDeveloperTools}
          />

          <PushNotificationsSection
            enabled={pushEnabled}
            setEnabled={setPushEnabled}
            notifyUnauthorizedOTP={pushNotifyUnauthorizedOTP}
            setNotifyUnauthorizedOTP={setPushNotifyUnauthorizedOTP}
            notifyFailedAdminLogin={pushNotifyFailedAdminLogin}
            setNotifyFailedAdminLogin={setPushNotifyFailedAdminLogin}
            notifySuccessfulAdminLogin={pushNotifySuccessfulAdminLogin}
            setNotifySuccessfulAdminLogin={setPushNotifySuccessfulAdminLogin}
            notifyFailedSharePasswordAttempt={pushNotifyFailedSharePasswordAttempt}
            setNotifyFailedSharePasswordAttempt={setPushNotifyFailedSharePasswordAttempt}
            notifySuccessfulShareAccess={pushNotifySuccessfulShareAccess}
            setNotifySuccessfulShareAccess={setPushNotifySuccessfulShareAccess}
            notifyGuestVideoLinkAccess={pushNotifyGuestVideoLinkAccess}
            setNotifyGuestVideoLinkAccess={setPushNotifyGuestVideoLinkAccess}
            notifyClientComments={pushNotifyClientComments}
            setNotifyClientComments={setPushNotifyClientComments}
            notifyInternalComments={pushNotifyInternalComments}
            setNotifyInternalComments={setPushNotifyInternalComments}
            notifyTaskComments={pushNotifyTaskComments}
            setNotifyTaskComments={setPushNotifyTaskComments}
            notifyVideoApproval={pushNotifyVideoApproval}
            setNotifyVideoApproval={setPushNotifyVideoApproval}
            notifyUserAssignments={pushNotifyUserAssignments}
            setNotifyUserAssignments={setPushNotifyUserAssignments}
            notifySalesQuoteViewed={pushNotifySalesQuoteViewed}
            setNotifySalesQuoteViewed={setPushNotifySalesQuoteViewed}
            notifySalesQuoteAccepted={pushNotifySalesQuoteAccepted}
            setNotifySalesQuoteAccepted={setPushNotifySalesQuoteAccepted}
            notifySalesInvoiceViewed={pushNotifySalesInvoiceViewed}
            setNotifySalesInvoiceViewed={setPushNotifySalesInvoiceViewed}
            notifySalesInvoicePaid={pushNotifySalesInvoicePaid}
            setNotifySalesInvoicePaid={setPushNotifySalesInvoicePaid}
            notifySalesReminders={pushNotifySalesReminders}
            setNotifySalesReminders={setPushNotifySalesReminders}
            notifyPasswordResetRequested={pushNotifyPasswordResetRequested}
            setNotifyPasswordResetRequested={setPushNotifyPasswordResetRequested}
            notifyPasswordResetSuccess={pushNotifyPasswordResetSuccess}
            setNotifyPasswordResetSuccess={setPushNotifyPasswordResetSuccess}
            show={showPushNotifications}
            setShow={setShowPushNotifications}
          />

          <SecuritySettingsSection
            showSecuritySettings={showSecuritySettings}
            setShowSecuritySettings={setShowSecuritySettings}
            httpsEnabled={httpsEnabled}
            hotlinkProtection={hotlinkProtection}
            setHotlinkProtection={setHotlinkProtection}
            ipRateLimit={ipRateLimit}
            setIpRateLimit={setIpRateLimit}
            sessionRateLimit={sessionRateLimit}
            setSessionRateLimit={setSessionRateLimit}
            shareSessionRateLimit={shareSessionRateLimit}
            setShareSessionRateLimit={setShareSessionRateLimit}
            shareTokenTtlSeconds={shareTokenTtlSeconds}
            setShareTokenTtlSeconds={setShareTokenTtlSeconds}
            passwordAttempts={passwordAttempts}
            setPasswordAttempts={setPasswordAttempts}
            sessionTimeoutValue={sessionTimeoutValue}
            setSessionTimeoutValue={setSessionTimeoutValue}
            sessionTimeoutUnit={sessionTimeoutUnit}
            setSessionTimeoutUnit={setSessionTimeoutUnit}
            trackAnalytics={trackAnalytics}
            setTrackAnalytics={setTrackAnalytics}
            trackSecurityLogs={trackSecurityLogs}
            setTrackSecurityLogs={setTrackSecurityLogs}
            viewSecurityEvents={viewSecurityEvents}
            setViewSecurityEvents={setViewSecurityEvents}
            maxInternalCommentsPerProject={maxInternalCommentsPerProject}
            setMaxInternalCommentsPerProject={setMaxInternalCommentsPerProject}
            maxCommentsPerVideoVersion={maxCommentsPerVideoVersion}
            setMaxCommentsPerVideoVersion={setMaxCommentsPerVideoVersion}
            maxProjectRecipients={maxProjectRecipients}
            setMaxProjectRecipients={setMaxProjectRecipients}
            maxProjectFilesPerProject={maxProjectFilesPerProject}
            setMaxProjectFilesPerProject={setMaxProjectFilesPerProject}
            blockedIPs={blockedIPs}
            blockedDomains={blockedDomains}
            newIP={newIP}
            setNewIP={setNewIP}
            newIPReason={newIPReason}
            setNewIPReason={setNewIPReason}
            newDomain={newDomain}
            setNewDomain={setNewDomain}
            newDomainReason={newDomainReason}
            setNewDomainReason={setNewDomainReason}
            onAddIP={handleAddIP}
            onRemoveIP={handleRemoveIP}
            onAddDomain={handleAddDomain}
            onRemoveDomain={handleRemoveDomain}
            blocklistsLoading={blocklistsLoading}
          />
        </div>

        {/* Desktop: sidebar nav + content panel (hidden on mobile) */}
        <div className="hidden lg:flex gap-6 mt-4">
          {/* Left sidebar */}
          <div className="w-52 xl:w-60 flex-shrink-0">
            <nav className="space-y-0.5 sticky top-6">
              {SETTING_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  onClick={() => handleSectionChange(section.id)}
                  className={cn(
                    'w-full text-left px-3 py-2.5 rounded-md text-sm flex items-center gap-2.5 transition-colors',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  )}
                >
                  <section.icon className="w-4 h-4 flex-shrink-0" />
                  {section.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Right content panel */}
          <div className="flex-1 min-w-0">
            {activeSection === 'company-branding' && (
              <CompanyBrandingSection
                companyName={companyName}
                setCompanyName={setCompanyName}
                companyLogoMode={companyLogoMode}
                setCompanyLogoMode={setCompanyLogoMode}
                companyLogoLinkUrl={companyLogoUrl}
                setCompanyLogoLinkUrl={setCompanyLogoUrl}
                companyLogoConfigured={companyLogoMode === 'UPLOAD' && !!settings?.companyLogoPath}
                companyLogoUrl={
                  companyLogoMode === 'UPLOAD'
                    ? (settings?.companyLogoPath ? `/api/branding/logo?v=${companyLogoVersion}` : null)
                    : (companyLogoMode === 'LINK' ? (companyLogoUrl || null) : null)
                }
                darkLogoEnabled={darkLogoEnabled}
                setDarkLogoEnabled={setDarkLogoEnabled}
                darkLogoMode={darkLogoMode}
                setDarkLogoMode={setDarkLogoMode}
                darkLogoLinkUrl={darkLogoUrl}
                setDarkLogoLinkUrl={setDarkLogoUrl}
                darkLogoConfigured={darkLogoMode === 'UPLOAD' && !!settings?.darkLogoPath}
                darkLogoUrl={
                  darkLogoMode === 'UPLOAD'
                    ? (settings?.darkLogoPath ? `/api/branding/dark-logo?v=${darkLogoVersion}` : null)
                    : (darkLogoMode === 'LINK' ? (darkLogoUrl || null) : null)
                }
                onDarkLogoUploaded={() => {
                  setDarkLogoVersion(Date.now())
                  apiFetch('/api/settings')
                    .then((r) => r.ok ? r.json() : null)
                    .then((d) => {
                      if (!d) return
                      setSettings(d)
                      setDarkLogoEnabled(!!d.darkLogoEnabled)
                      setDarkLogoMode((d.darkLogoMode as any) || 'NONE')
                      setDarkLogoUrl(d.darkLogoUrl || '')
                    })
                    .catch(() => {})
                }}
                companyFaviconMode={companyFaviconMode}
                setCompanyFaviconMode={setCompanyFaviconMode}
                companyFaviconLinkUrl={companyFaviconUrl}
                setCompanyFaviconLinkUrl={setCompanyFaviconUrl}
                companyFaviconConfigured={companyFaviconMode === 'UPLOAD' && !!settings?.companyFaviconPath}
                companyFaviconUrl={
                  companyFaviconMode === 'UPLOAD'
                    ? (settings?.companyFaviconPath ? `/api/branding/favicon?v=${companyFaviconVersion}` : null)
                    : (companyFaviconMode === 'LINK' ? (companyFaviconUrl || null) : null)
                }
                onCompanyLogoUploaded={() => {
                  setCompanyLogoVersion(Date.now())
                  setCompanyFaviconVersion(Date.now())
                  apiFetch('/api/settings')
                    .then((r) => r.ok ? r.json() : null)
                    .then((d) => {
                      if (!d) return
                      setSettings(d)
                      setCompanyLogoMode((d.companyLogoMode as any) || 'NONE')
                      setCompanyLogoUrl(d.companyLogoUrl || '')
                      setCompanyFaviconMode((d.companyFaviconMode as any) || 'NONE')
                      setCompanyFaviconUrl(d.companyFaviconUrl || '')
                      setDarkLogoEnabled(!!d.darkLogoEnabled)
                      setDarkLogoMode((d.darkLogoMode as any) || 'NONE')
                      setDarkLogoUrl(d.darkLogoUrl || '')
                    })
                    .catch(() => {})
                }}
                onCompanyFaviconUploaded={() => {
                  setCompanyFaviconVersion(Date.now())
                  apiFetch('/api/settings')
                    .then((r) => r.ok ? r.json() : null)
                    .then((d) => {
                      if (!d) return
                      setSettings(d)
                      setCompanyFaviconMode((d.companyFaviconMode as any) || 'NONE')
                      setCompanyFaviconUrl(d.companyFaviconUrl || '')
                    })
                    .catch(() => {})
                }}
                accentColor={accentColor}
                setAccentColor={setAccentColor}
                accentTextMode={accentTextMode}
                setAccentTextMode={setAccentTextMode}
                emailHeaderColor={emailHeaderColor}
                setEmailHeaderColor={setEmailHeaderColor}
                emailHeaderTextMode={emailHeaderTextMode}
                setEmailHeaderTextMode={setEmailHeaderTextMode}
                defaultTheme={defaultTheme}
                setDefaultTheme={setDefaultTheme}
                allowThemeToggle={allowThemeToggle}
                setAllowThemeToggle={setAllowThemeToggle}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'domain' && (
              <DomainConfigurationSection
                appDomain={appDomain}
                setAppDomain={setAppDomain}
                mainCompanyDomain={mainCompanyDomain}
                setMainCompanyDomain={setMainCompanyDomain}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'email' && (
              <EmailSettingsSection
                smtpServer={smtpServer}
                setSmtpServer={setSmtpServer}
                smtpPort={smtpPort}
                setSmtpPort={setSmtpPort}
                smtpUsername={smtpUsername}
                setSmtpUsername={setSmtpUsername}
                smtpPassword={smtpPassword}
                setSmtpPassword={setSmtpPassword}
                emailTrackingPixelsEnabled={emailTrackingPixelsEnabled}
                setEmailTrackingPixelsEnabled={setEmailTrackingPixelsEnabled}
                emailCustomFooterText={emailCustomFooterText}
                setEmailCustomFooterText={setEmailCustomFooterText}
                smtpFromAddress={smtpFromAddress}
                setSmtpFromAddress={setSmtpFromAddress}
                smtpSecure={smtpSecure}
                setSmtpSecure={setSmtpSecure}
                testEmailAddress={testEmailAddress}
                setTestEmailAddress={setTestEmailAddress}
                testEmailSending={testEmailSending}
                testEmailResult={testEmailResult}
                handleTestEmail={handleTestEmail}
                adminNotificationSchedule={adminNotificationSchedule}
                setAdminNotificationSchedule={setAdminNotificationSchedule}
                adminNotificationTime={adminNotificationTime}
                setAdminNotificationTime={setAdminNotificationTime}
                adminNotificationDay={adminNotificationDay}
                setAdminNotificationDay={setAdminNotificationDay}
                adminEmailProjectApproved={adminEmailProjectApproved}
                setAdminEmailProjectApproved={setAdminEmailProjectApproved}
                adminEmailInternalComments={adminEmailInternalComments}
                setAdminEmailInternalComments={setAdminEmailInternalComments}
                adminEmailTaskComments={adminEmailTaskComments}
                setAdminEmailTaskComments={setAdminEmailTaskComments}
                adminEmailInvoicePaid={adminEmailInvoicePaid}
                setAdminEmailInvoicePaid={setAdminEmailInvoicePaid}
                adminEmailQuoteAccepted={adminEmailQuoteAccepted}
                setAdminEmailQuoteAccepted={setAdminEmailQuoteAccepted}
                adminEmailProjectKeyDates={adminEmailProjectKeyDates}
                setAdminEmailProjectKeyDates={setAdminEmailProjectKeyDates}
                adminEmailUserKeyDates={adminEmailUserKeyDates}
                setAdminEmailUserKeyDates={setAdminEmailUserKeyDates}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'cpu' && (
              <CpuConfigurationSection
                show={true}
                setShow={() => {}}
                hideCollapse
                detectedThreads={cpuDetectedThreads}
                budgetThreads={cpuBudgetThreads}
                reservedSystemThreads={cpuReservedSystemThreads}
                maxFfmpegThreadsPerJob={cpuMaxFfmpegThreadsPerJob}
                ffmpegThreadsPerJob={cpuFfmpegThreadsPerJob}
                setFfmpegThreadsPerJob={setCpuFfmpegThreadsPerJob}
                videoWorkerConcurrency={cpuVideoWorkerConcurrency}
                setVideoWorkerConcurrency={setCpuVideoWorkerConcurrency}
                dynamicThreadAllocation={cpuDynamicThreadAllocation}
                setDynamicThreadAllocation={setCpuDynamicThreadAllocation}
                defaultFfmpegThreadsPerJob={cpuDefaultFfmpegThreadsPerJob}
                defaultVideoWorkerConcurrency={cpuDefaultVideoWorkerConcurrency}
              />
            )}

            {activeSection === 'storage' && (
              <StorageOverviewSection
                show={true}
                setShow={() => {}}
                hideCollapse
                autoDeletePreviewsOnClose={autoDeletePreviewsOnClose}
                setAutoDeletePreviewsOnClose={setAutoDeletePreviewsOnClose}
                onRecalculateProjectDataTotals={handleRecalculateProjectDataTotals}
                recalculateProjectDataTotalsLoading={recalcProjectDataLoading}
                recalculateProjectDataTotalsResult={recalcProjectDataResult}
              />
            )}

            {activeSection === 'dropbox' && (
              <DropboxStorageSection
                show={true}
                setShow={() => {}}
                hideCollapse
                dropboxConfigured={dropboxConfigured}
                dropboxRootPath={dropboxRootPath}
              />
            )}

            {activeSection === 'video-processing' && (
              <VideoProcessingSettingsSection
                defaultPreviewResolutions={defaultPreviewResolutions}
                setDefaultPreviewResolutions={setDefaultPreviewResolutions}
                defaultWatermarkEnabled={defaultWatermarkEnabled}
                setDefaultWatermarkEnabled={setDefaultWatermarkEnabled}
                defaultTimelinePreviewsEnabled={defaultTimelinePreviewsEnabled}
                setDefaultTimelinePreviewsEnabled={setDefaultTimelinePreviewsEnabled}
                defaultWatermarkText={defaultWatermarkText}
                setDefaultWatermarkText={setDefaultWatermarkText}
                defaultAllowClientDeleteComments={defaultAllowClientDeleteComments}
                setDefaultAllowClientDeleteComments={setDefaultAllowClientDeleteComments}
                defaultAllowClientUploadFiles={defaultAllowClientUploadFiles}
                setDefaultAllowClientUploadFiles={setDefaultAllowClientUploadFiles}
                defaultAllowAuthenticatedProjectSwitching={defaultAllowAuthenticatedProjectSwitching}
                setDefaultAllowAuthenticatedProjectSwitching={setDefaultAllowAuthenticatedProjectSwitching}
                defaultMaxClientUploadAllocationMB={defaultMaxClientUploadAllocationMB}
                setDefaultMaxClientUploadAllocationMB={setDefaultMaxClientUploadAllocationMB}
                defaultClientNotificationSchedule={defaultClientNotificationSchedule}
                setDefaultClientNotificationSchedule={setDefaultClientNotificationSchedule}
                defaultClientNotificationTime={defaultClientNotificationTime}
                setDefaultClientNotificationTime={setDefaultClientNotificationTime}
                defaultClientNotificationDay={defaultClientNotificationDay}
                setDefaultClientNotificationDay={setDefaultClientNotificationDay}
                clientEmailProjectApproved={clientEmailProjectApproved}
                setClientEmailProjectApproved={setClientEmailProjectApproved}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'project-behavior' && (
              <ProjectBehaviorSection
                autoApproveProject={autoApproveProject}
                setAutoApproveProject={setAutoApproveProject}
                autoCloseApprovedProjectsEnabled={autoCloseApprovedProjectsEnabled}
                setAutoCloseApprovedProjectsEnabled={setAutoCloseApprovedProjectsEnabled}
                autoCloseApprovedProjectsAfterDays={autoCloseApprovedProjectsAfterDays}
                setAutoCloseApprovedProjectsAfterDays={setAutoCloseApprovedProjectsAfterDays}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'developer-tools' && (
              <DeveloperToolsSection
                excludeInternalIpsFromAnalytics={excludeInternalIpsFromAnalytics}
                setExcludeInternalIpsFromAnalytics={setExcludeInternalIpsFromAnalytics}
                uploadChunkSizeMB={uploadChunkSizeMB}
                setUploadChunkSizeMB={setUploadChunkSizeMB}
                downloadChunkSizeMB={downloadChunkSizeMB}
                setDownloadChunkSizeMB={setDownloadChunkSizeMB}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'push-notifications' && (
              <PushNotificationsSection
                enabled={pushEnabled}
                setEnabled={setPushEnabled}
                notifyUnauthorizedOTP={pushNotifyUnauthorizedOTP}
                setNotifyUnauthorizedOTP={setPushNotifyUnauthorizedOTP}
                notifyFailedAdminLogin={pushNotifyFailedAdminLogin}
                setNotifyFailedAdminLogin={setPushNotifyFailedAdminLogin}
                notifySuccessfulAdminLogin={pushNotifySuccessfulAdminLogin}
                setNotifySuccessfulAdminLogin={setPushNotifySuccessfulAdminLogin}
                notifyFailedSharePasswordAttempt={pushNotifyFailedSharePasswordAttempt}
                setNotifyFailedSharePasswordAttempt={setPushNotifyFailedSharePasswordAttempt}
                notifySuccessfulShareAccess={pushNotifySuccessfulShareAccess}
                setNotifySuccessfulShareAccess={setPushNotifySuccessfulShareAccess}
                notifyGuestVideoLinkAccess={pushNotifyGuestVideoLinkAccess}
                setNotifyGuestVideoLinkAccess={setPushNotifyGuestVideoLinkAccess}
                notifyClientComments={pushNotifyClientComments}
                setNotifyClientComments={setPushNotifyClientComments}
                notifyInternalComments={pushNotifyInternalComments}
                setNotifyInternalComments={setPushNotifyInternalComments}
                notifyTaskComments={pushNotifyTaskComments}
                setNotifyTaskComments={setPushNotifyTaskComments}
                notifyVideoApproval={pushNotifyVideoApproval}
                setNotifyVideoApproval={setPushNotifyVideoApproval}
                notifyUserAssignments={pushNotifyUserAssignments}
                setNotifyUserAssignments={setPushNotifyUserAssignments}
                notifySalesQuoteViewed={pushNotifySalesQuoteViewed}
                setNotifySalesQuoteViewed={setPushNotifySalesQuoteViewed}
                notifySalesQuoteAccepted={pushNotifySalesQuoteAccepted}
                setNotifySalesQuoteAccepted={setPushNotifySalesQuoteAccepted}
                notifySalesInvoiceViewed={pushNotifySalesInvoiceViewed}
                setNotifySalesInvoiceViewed={setPushNotifySalesInvoiceViewed}
                notifySalesInvoicePaid={pushNotifySalesInvoicePaid}
                setNotifySalesInvoicePaid={setPushNotifySalesInvoicePaid}
                notifySalesReminders={pushNotifySalesReminders}
                setNotifySalesReminders={setPushNotifySalesReminders}
                notifyPasswordResetRequested={pushNotifyPasswordResetRequested}
                setNotifyPasswordResetRequested={setPushNotifyPasswordResetRequested}
                notifyPasswordResetSuccess={pushNotifyPasswordResetSuccess}
                setNotifyPasswordResetSuccess={setPushNotifyPasswordResetSuccess}
                show={true}
                setShow={() => {}}
                hideCollapse
              />
            )}

            {activeSection === 'security' && (
              <SecuritySettingsSection
                showSecuritySettings={true}
                setShowSecuritySettings={() => {}}
                hideCollapse
                httpsEnabled={httpsEnabled}
                hotlinkProtection={hotlinkProtection}
                setHotlinkProtection={setHotlinkProtection}
                ipRateLimit={ipRateLimit}
                setIpRateLimit={setIpRateLimit}
                sessionRateLimit={sessionRateLimit}
                setSessionRateLimit={setSessionRateLimit}
                shareSessionRateLimit={shareSessionRateLimit}
                setShareSessionRateLimit={setShareSessionRateLimit}
                shareTokenTtlSeconds={shareTokenTtlSeconds}
                setShareTokenTtlSeconds={setShareTokenTtlSeconds}
                passwordAttempts={passwordAttempts}
                setPasswordAttempts={setPasswordAttempts}
                sessionTimeoutValue={sessionTimeoutValue}
                setSessionTimeoutValue={setSessionTimeoutValue}
                sessionTimeoutUnit={sessionTimeoutUnit}
                setSessionTimeoutUnit={setSessionTimeoutUnit}
                trackAnalytics={trackAnalytics}
                setTrackAnalytics={setTrackAnalytics}
                trackSecurityLogs={trackSecurityLogs}
                setTrackSecurityLogs={setTrackSecurityLogs}
                viewSecurityEvents={viewSecurityEvents}
                setViewSecurityEvents={setViewSecurityEvents}
                maxInternalCommentsPerProject={maxInternalCommentsPerProject}
                setMaxInternalCommentsPerProject={setMaxInternalCommentsPerProject}
                maxCommentsPerVideoVersion={maxCommentsPerVideoVersion}
                setMaxCommentsPerVideoVersion={setMaxCommentsPerVideoVersion}
                maxProjectRecipients={maxProjectRecipients}
                setMaxProjectRecipients={setMaxProjectRecipients}
                maxProjectFilesPerProject={maxProjectFilesPerProject}
                setMaxProjectFilesPerProject={setMaxProjectFilesPerProject}
                blockedIPs={blockedIPs}
                blockedDomains={blockedDomains}
                newIP={newIP}
                setNewIP={setNewIP}
                newIPReason={newIPReason}
                setNewIPReason={setNewIPReason}
                newDomain={newDomain}
                setNewDomain={setNewDomain}
                newDomainReason={newDomainReason}
                setNewDomainReason={setNewDomainReason}
                onAddIP={handleAddIP}
                onRemoveIP={handleRemoveIP}
                onAddDomain={handleAddDomain}
                onRemoveDomain={handleRemoveDomain}
                blocklistsLoading={blocklistsLoading}
              />
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
          <Button onClick={handleSave} variant="default" disabled={saving} size="lg" className="w-full sm:w-auto">
            <Save className="w-4 h-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  )
}
