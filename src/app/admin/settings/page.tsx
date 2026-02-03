'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Settings as SettingsIcon, Save } from 'lucide-react'
import { CompanyBrandingSection } from '@/components/settings/CompanyBrandingSection'
import { DomainConfigurationSection } from '@/components/settings/DomainConfigurationSection'
import { EmailSettingsSection } from '@/components/settings/EmailSettingsSection'
import { VideoProcessingSettingsSection } from '@/components/settings/VideoProcessingSettingsSection'
import { ProjectBehaviorSection } from '@/components/settings/ProjectBehaviorSection'
import { DeveloperToolsSection } from '@/components/settings/DeveloperToolsSection'
import { SecuritySettingsSection } from '@/components/settings/SecuritySettingsSection'
import { PushNotificationsSection } from '@/components/settings/PushNotificationsSection'
import { AdminBrowserPushSection } from '@/components/settings/AdminBrowserPushSection'
import { apiPatch, apiPost, apiFetch } from '@/lib/api-client'

interface Settings {
  id: string
  companyName: string | null
  companyLogoMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyLogoPath?: string | null
  companyLogoUrl?: string | null
  companyFaviconMode?: 'NONE' | 'UPLOAD' | 'LINK' | null
  companyFaviconPath?: string | null
  companyFaviconUrl?: string | null
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
  defaultMaxClientUploadAllocationMB: number | null
  autoApproveProject: boolean | null
  autoCloseApprovedProjectsEnabled?: boolean | null
  autoCloseApprovedProjectsAfterDays?: number | null
  adminNotificationSchedule: string | null
  adminNotificationTime: string | null
  adminNotificationDay: number | null
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

interface PushNotificationSettings {
  id: string
  enabled: boolean
  provider: string | null
  webhookUrl: string | null
  title: string | null
  notifyUnauthorizedOTP: boolean
  notifyFailedAdminLogin: boolean
  notifySuccessfulAdminLogin: boolean
  notifyFailedSharePasswordAttempt: boolean
  notifySuccessfulShareAccess: boolean
  notifyGuestVideoLinkAccess: boolean
  notifyClientComments: boolean
  notifyVideoApproval: boolean
  notifySalesQuoteViewed: boolean
  notifySalesQuoteAccepted: boolean
  notifySalesInvoiceViewed: boolean
  notifySalesInvoicePaid: boolean
  notifyPasswordResetRequested: boolean
  notifyPasswordResetSuccess: boolean
}

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
  const [smtpServer, setSmtpServer] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [emailTrackingPixelsEnabled, setEmailTrackingPixelsEnabled] = useState(true)
  const [smtpFromAddress, setSmtpFromAddress] = useState('')
  const [smtpSecure, setSmtpSecure] = useState('STARTTLS')
  const [appDomain, setAppDomain] = useState('')
  const [defaultPreviewResolution, setDefaultPreviewResolution] = useState('720p')
  const [defaultWatermarkEnabled, setDefaultWatermarkEnabled] = useState(true)
  const [defaultTimelinePreviewsEnabled, setDefaultTimelinePreviewsEnabled] = useState(false)
  const [defaultWatermarkText, setDefaultWatermarkText] = useState('')
  const [defaultAllowClientDeleteComments, setDefaultAllowClientDeleteComments] = useState(false)
  const [defaultAllowClientUploadFiles, setDefaultAllowClientUploadFiles] = useState(false)
  const [defaultMaxClientUploadAllocationMB, setDefaultMaxClientUploadAllocationMB] = useState<number | ''>(1000)
  const [autoApproveProject, setAutoApproveProject] = useState(true)

  const [autoCloseApprovedProjectsEnabled, setAutoCloseApprovedProjectsEnabled] = useState(false)
  const [autoCloseApprovedProjectsAfterDays, setAutoCloseApprovedProjectsAfterDays] = useState<number | ''>(7)

  // Form state for admin notification settings
  const [adminNotificationSchedule, setAdminNotificationSchedule] = useState('HOURLY')
  const [adminNotificationTime, setAdminNotificationTime] = useState('09:00')
  const [adminNotificationDay, setAdminNotificationDay] = useState(1)

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
  const [pushNotificationSettings, setPushNotificationSettings] = useState<PushNotificationSettings | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushProvider, setPushProvider] = useState('')
  const [pushWebhookUrl, setPushWebhookUrl] = useState('')
  const [pushTitlePrefix, setPushTitlePrefix] = useState('')
  const [pushNotifyUnauthorizedOTP, setPushNotifyUnauthorizedOTP] = useState(true)
  const [pushNotifyFailedAdminLogin, setPushNotifyFailedAdminLogin] = useState(true)
  const [pushNotifySuccessfulAdminLogin, setPushNotifySuccessfulAdminLogin] = useState(true)
  const [pushNotifyFailedSharePasswordAttempt, setPushNotifyFailedSharePasswordAttempt] = useState(true)
  const [pushNotifySuccessfulShareAccess, setPushNotifySuccessfulShareAccess] = useState(true)
  const [pushNotifyGuestVideoLinkAccess, setPushNotifyGuestVideoLinkAccess] = useState(true)
  const [pushNotifyClientComments, setPushNotifyClientComments] = useState(true)
  const [pushNotifyVideoApproval, setPushNotifyVideoApproval] = useState(true)
  const [pushNotifySalesQuoteViewed, setPushNotifySalesQuoteViewed] = useState(true)
  const [pushNotifySalesQuoteAccepted, setPushNotifySalesQuoteAccepted] = useState(true)
  const [pushNotifySalesInvoiceViewed, setPushNotifySalesInvoiceViewed] = useState(true)
  const [pushNotifySalesInvoicePaid, setPushNotifySalesInvoicePaid] = useState(true)
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
  const [showBrowserPush, setShowBrowserPush] = useState(false)

  const [recalcProjectDataLoading, setRecalcProjectDataLoading] = useState(false)
  const [recalcProjectDataResult, setRecalcProjectDataResult] = useState<string | null>(null)

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
        setSmtpServer(data.smtpServer || '')
        setSmtpPort(data.smtpPort?.toString() || '587')
        setSmtpUsername(data.smtpUsername || '')
        setSmtpPassword(data.smtpPassword || '')
        setEmailTrackingPixelsEnabled(data.emailTrackingPixelsEnabled ?? true)
        setSmtpFromAddress(data.smtpFromAddress || '')
        setSmtpSecure(data.smtpSecure || 'STARTTLS')
        setAppDomain(data.appDomain || '')
        setDefaultPreviewResolution(data.defaultPreviewResolution || '720p')
        setDefaultWatermarkEnabled(data.defaultWatermarkEnabled ?? true)
        setDefaultTimelinePreviewsEnabled(data.defaultTimelinePreviewsEnabled ?? false)
        setDefaultWatermarkText(data.defaultWatermarkText || '')
        setDefaultAllowClientDeleteComments(data.defaultAllowClientDeleteComments ?? false)
        setDefaultAllowClientUploadFiles(data.defaultAllowClientUploadFiles ?? false)
        setDefaultMaxClientUploadAllocationMB(data.defaultMaxClientUploadAllocationMB ?? 1000)
        setAutoApproveProject(data.autoApproveProject ?? true)
        setAutoCloseApprovedProjectsEnabled(data.autoCloseApprovedProjectsEnabled ?? false)
        setAutoCloseApprovedProjectsAfterDays(data.autoCloseApprovedProjectsAfterDays ?? 7)
        setTestEmailAddress(data.smtpFromAddress || '')

        // Set notification settings
        setAdminNotificationSchedule(data.adminNotificationSchedule || 'HOURLY')
        setAdminNotificationTime(data.adminNotificationTime || '09:00')
        setAdminNotificationDay(data.adminNotificationDay ?? 1)

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
          setPushNotificationSettings(pushData)

          // Set push notification form values
          setPushEnabled(pushData.enabled ?? false)
          setPushProvider(pushData.provider || '')
          setPushWebhookUrl(pushData.webhookUrl || '')
          setPushTitlePrefix(pushData.title || '')
          setPushNotifyUnauthorizedOTP(pushData.notifyUnauthorizedOTP ?? true)
          setPushNotifyFailedAdminLogin(pushData.notifyFailedAdminLogin ?? true)
          setPushNotifySuccessfulAdminLogin(pushData.notifySuccessfulAdminLogin ?? true)
          setPushNotifyFailedSharePasswordAttempt(pushData.notifyFailedSharePasswordAttempt ?? true)
          setPushNotifySuccessfulShareAccess(pushData.notifySuccessfulShareAccess ?? true)
          setPushNotifyGuestVideoLinkAccess(pushData.notifyGuestVideoLinkAccess ?? true)
          setPushNotifyClientComments(pushData.notifyClientComments ?? true)
          setPushNotifyVideoApproval(pushData.notifyVideoApproval ?? true)
          setPushNotifySalesQuoteViewed(pushData.notifySalesQuoteViewed ?? true)
          setPushNotifySalesQuoteAccepted(pushData.notifySalesQuoteAccepted ?? true)
          setPushNotifySalesInvoiceViewed(pushData.notifySalesInvoiceViewed ?? true)
          setPushNotifySalesInvoicePaid(pushData.notifySalesInvoicePaid ?? true)
          setPushNotifyPasswordResetRequested(pushData.notifyPasswordResetRequested ?? true)
          setPushNotifyPasswordResetSuccess(pushData.notifyPasswordResetSuccess ?? true)
        }
      } catch (err) {
        setError('Failed to load settings')
      } finally {
        setLoading(false)
      }
    }

    loadSettings()
  }, [])

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
      const updates = {
        companyName: companyName || null,
        companyLogoMode: companyLogoMode || 'NONE',
        companyLogoUrl: companyLogoMode === 'LINK' ? (companyLogoUrl || null) : null,
        companyFaviconMode: companyFaviconMode || 'NONE',
        companyFaviconUrl: companyFaviconMode === 'LINK' ? (companyFaviconUrl || null) : null,
        smtpServer: smtpServer || null,
        smtpPort: smtpPort ? parseInt(smtpPort, 10) : 587,
        smtpUsername: smtpUsername || null,
        smtpPassword: smtpPassword || null,
        emailTrackingPixelsEnabled,
        smtpFromAddress: smtpFromAddress || null,
        smtpSecure: smtpSecure || 'STARTTLS',
        appDomain: appDomain || null,
        defaultPreviewResolution: defaultPreviewResolution || '720p',
        defaultWatermarkEnabled: defaultWatermarkEnabled,
        defaultTimelinePreviewsEnabled: defaultTimelinePreviewsEnabled,
        defaultWatermarkText: defaultWatermarkText || null,
        defaultAllowClientDeleteComments,
        defaultAllowClientUploadFiles,
        defaultMaxClientUploadAllocationMB: typeof defaultMaxClientUploadAllocationMB === 'number'
          ? defaultMaxClientUploadAllocationMB
          : parseInt(String(defaultMaxClientUploadAllocationMB), 10) || 0,
        autoApproveProject: autoApproveProject,
        autoCloseApprovedProjectsEnabled: autoCloseApprovedProjectsEnabled,
        autoCloseApprovedProjectsAfterDays: typeof autoCloseApprovedProjectsAfterDays === 'number'
          ? autoCloseApprovedProjectsAfterDays
          : parseInt(String(autoCloseApprovedProjectsAfterDays), 10) || 7,
        adminNotificationSchedule: adminNotificationSchedule,
        adminNotificationTime: (adminNotificationSchedule === 'DAILY' || adminNotificationSchedule === 'WEEKLY') ? adminNotificationTime : null,
        adminNotificationDay: adminNotificationSchedule === 'WEEKLY' ? adminNotificationDay : null,
      }

      // Save global settings
      await apiPatch('/api/settings', updates)

      // Save security settings
      const securityUpdates = {
        httpsEnabled,
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
        provider: pushProvider || null,
        webhookUrl: pushWebhookUrl || null,
        title: pushTitlePrefix || null,
        notifyUnauthorizedOTP: pushNotifyUnauthorizedOTP,
        notifyFailedAdminLogin: pushNotifyFailedAdminLogin,
        notifySuccessfulAdminLogin: pushNotifySuccessfulAdminLogin,
        notifyFailedSharePasswordAttempt: pushNotifyFailedSharePasswordAttempt,
        notifySuccessfulShareAccess: pushNotifySuccessfulShareAccess,
        notifyGuestVideoLinkAccess: pushNotifyGuestVideoLinkAccess,
        notifyClientComments: pushNotifyClientComments,
        notifyVideoApproval: pushNotifyVideoApproval,
        notifySalesQuoteViewed: pushNotifySalesQuoteViewed,
        notifySalesQuoteAccepted: pushNotifySalesQuoteAccepted,
        notifySalesInvoiceViewed: pushNotifySalesInvoiceViewed,
        notifySalesInvoicePaid: pushNotifySalesInvoicePaid,
        notifyPasswordResetRequested: pushNotifyPasswordResetRequested,
        notifyPasswordResetSuccess: pushNotifyPasswordResetSuccess,
      }

      await apiPatch('/api/settings/push-notifications', pushUpdates)

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)

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
        setSmtpServer(refreshedData.smtpServer || '')
        setSmtpPort(refreshedData.smtpPort?.toString() || '587')
        setSmtpUsername(refreshedData.smtpUsername || '')
        setSmtpPassword(refreshedData.smtpPassword || '')
        setEmailTrackingPixelsEnabled(refreshedData.emailTrackingPixelsEnabled ?? true)
        setSmtpFromAddress(refreshedData.smtpFromAddress || '')
        setSmtpSecure(refreshedData.smtpSecure || 'STARTTLS')
        setAppDomain(refreshedData.appDomain || '')
        setDefaultPreviewResolution(refreshedData.defaultPreviewResolution || '720p')
        setDefaultWatermarkEnabled(refreshedData.defaultWatermarkEnabled ?? true)
        setDefaultTimelinePreviewsEnabled(refreshedData.defaultTimelinePreviewsEnabled ?? false)
        setDefaultWatermarkText(refreshedData.defaultWatermarkText || '')
        setDefaultAllowClientDeleteComments(refreshedData.defaultAllowClientDeleteComments ?? false)
        setDefaultAllowClientUploadFiles(refreshedData.defaultAllowClientUploadFiles ?? false)
        setDefaultMaxClientUploadAllocationMB(refreshedData.defaultMaxClientUploadAllocationMB ?? 1000)
        setAutoApproveProject(refreshedData.autoApproveProject ?? true)
        setAutoCloseApprovedProjectsEnabled(refreshedData.autoCloseApprovedProjectsEnabled ?? false)
        setAutoCloseApprovedProjectsAfterDays(refreshedData.autoCloseApprovedProjectsAfterDays ?? 7)
        setAdminNotificationSchedule(refreshedData.adminNotificationSchedule || 'HOURLY')
        setAdminNotificationTime(refreshedData.adminNotificationTime || '09:00')
        setAdminNotificationDay(refreshedData.adminNotificationDay ?? 1)
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
        <div className="max-w-4xl mx-auto">
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
            <p className="text-xs sm:text-sm text-success font-medium">Settings saved successfully!</p>
          </div>
        )}

        <div className="space-y-4 sm:space-y-6">
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
            show={showCompanyBranding}
            setShow={setShowCompanyBranding}
          />

          <DomainConfigurationSection
            appDomain={appDomain}
            setAppDomain={setAppDomain}
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
            show={showEmailSettings}
            setShow={setShowEmailSettings}
          />

          <VideoProcessingSettingsSection
            defaultPreviewResolution={defaultPreviewResolution}
            setDefaultPreviewResolution={setDefaultPreviewResolution}
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
            defaultMaxClientUploadAllocationMB={defaultMaxClientUploadAllocationMB}
            setDefaultMaxClientUploadAllocationMB={setDefaultMaxClientUploadAllocationMB}
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
            onRecalculateProjectDataTotals={handleRecalculateProjectDataTotals}
            recalculateProjectDataTotalsLoading={recalcProjectDataLoading}
            recalculateProjectDataTotalsResult={recalcProjectDataResult}
            show={showDeveloperTools}
            setShow={setShowDeveloperTools}
          />

          <PushNotificationsSection
            enabled={pushEnabled}
            setEnabled={setPushEnabled}
            provider={pushProvider}
            setProvider={setPushProvider}
            webhookUrl={pushWebhookUrl}
            setWebhookUrl={setPushWebhookUrl}
            titlePrefix={pushTitlePrefix}
            setTitlePrefix={setPushTitlePrefix}
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
            notifyVideoApproval={pushNotifyVideoApproval}
            setNotifyVideoApproval={setPushNotifyVideoApproval}
            notifySalesQuoteViewed={pushNotifySalesQuoteViewed}
            setNotifySalesQuoteViewed={setPushNotifySalesQuoteViewed}
            notifySalesQuoteAccepted={pushNotifySalesQuoteAccepted}
            setNotifySalesQuoteAccepted={setPushNotifySalesQuoteAccepted}
            notifySalesInvoiceViewed={pushNotifySalesInvoiceViewed}
            setNotifySalesInvoiceViewed={setPushNotifySalesInvoiceViewed}
            notifySalesInvoicePaid={pushNotifySalesInvoicePaid}
            setNotifySalesInvoicePaid={setPushNotifySalesInvoicePaid}
            notifyPasswordResetRequested={pushNotifyPasswordResetRequested}
            setNotifyPasswordResetRequested={setPushNotifyPasswordResetRequested}
            notifyPasswordResetSuccess={pushNotifyPasswordResetSuccess}
            setNotifyPasswordResetSuccess={setPushNotifyPasswordResetSuccess}
            show={showPushNotifications}
            setShow={setShowPushNotifications}
          />

          <AdminBrowserPushSection show={showBrowserPush} setShow={setShowBrowserPush} />

          <SecuritySettingsSection
            showSecuritySettings={showSecuritySettings}
            setShowSecuritySettings={setShowSecuritySettings}
            httpsEnabled={httpsEnabled}
            setHttpsEnabled={setHttpsEnabled}
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

        {/* Error notification at bottom */}
        {error && (
          <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-destructive-visible border-2 border-destructive-visible rounded-lg">
            <p className="text-xs sm:text-sm text-destructive font-medium">{error}</p>
          </div>
        )}

        {/* Success notification at bottom */}
        {success && (
          <div className="mt-4 sm:mt-6 p-3 sm:p-4 bg-success-visible border-2 border-success-visible rounded-lg">
            <p className="text-xs sm:text-sm text-success font-medium">Settings saved successfully!</p>
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
    </div>
  )
}
