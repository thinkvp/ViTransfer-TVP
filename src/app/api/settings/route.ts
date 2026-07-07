import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { encrypt, decrypt } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { invalidateEmailSettingsCache } from '@/lib/email'
import { invalidateSettingsCaches } from '@/lib/settings'
import {
  MAX_DOWNLOAD_CHUNK_SIZE_MB,
  MAX_UPLOAD_CHUNK_SIZE_MB,
  MIN_DOWNLOAD_CHUNK_SIZE_MB,
  MIN_UPLOAD_CHUNK_SIZE_MB,
  normalizeDownloadChunkSizeMB,
  normalizeUploadChunkSizeMB,
} from '@/lib/transfer-tuning'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
// SETTINGS_BRANDING has no project association — getStoredFilePathForProject() would return null.
// eslint-disable-next-line no-restricted-imports
import { getStoredFilePath } from '@/lib/stored-file'
export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Check authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult // Return 401/403 response
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  // Rate limiting to prevent enumeration/scraping
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 120,
    message: 'Too many requests. Please slow down.'
  }, 'settings-read', authResult.id)
  if (rateLimitResult) return rateLimitResult

  try {
    // Get or create the default settings records.
    let [settings, securitySettings] = await Promise.all([
      prisma.settings.findUnique({
        where: { id: 'default' },
      }),
      prisma.securitySettings.findUnique({
        where: { id: 'default' },
      }),
    ])

    const createMissingRecords: Array<Promise<void>> = []

    if (!settings) {
      createMissingRecords.push(
        prisma.settings.create({
          data: {
            id: 'default',
          },
        }).then((created) => {
          settings = created
        })
      )
    }

    if (!securitySettings) {
      createMissingRecords.push(
        prisma.securitySettings.create({
          data: {
            id: 'default',
          },
        }).then((created) => {
          securitySettings = created
        })
      )
    }

    if (createMissingRecords.length > 0) {
      await Promise.all(createMissingRecords)
    }

    // After the create-if-missing block, both records are guaranteed to exist.
    settings = settings!
    securitySettings = securitySettings!

    // Decrypt sensitive fields before sending to admin.
    // Exclude internal BigInt fields (accountingFilesBytes) that are not
    // needed by the settings UI and cannot be JSON-serialised.
    const { accountingFilesBytes: _accountingFilesBytes, ...settingsForClient } = settings
    const decryptedSettings = {
      ...settingsForClient,
      smtpPassword: settings.smtpPassword ? decrypt(settings.smtpPassword) : null,
      aiAnthropicApiKey: settings.aiAnthropicApiKey ? decrypt(settings.aiAnthropicApiKey) : null,
      aiOpenaiApiKey: settings.aiOpenaiApiKey ? decrypt(settings.aiOpenaiApiKey) : null,
      transcriptionOpenaiApiKey: settings.transcriptionOpenaiApiKey ? decrypt(settings.transcriptionOpenaiApiKey) : null,
      aiPortfolio: (() => {
        try {
          const arr = JSON.parse(settings.aiPortfolioJson || '[]')
          return Array.isArray(arr) ? arr : []
        } catch {
          return []
        }
      })(),
    }

    const smtpConfigured = !!(
      settings.smtpServer &&
      settings.smtpPort &&
      settings.smtpUsername &&
      settings.smtpPassword
    )

    const s3Configured = process.env.STORAGE_PROVIDER === 's3'
      && Boolean(process.env.S3_ENDPOINT?.trim())
      && Boolean(process.env.S3_ACCESS_KEY_ID?.trim())
      && Boolean(process.env.S3_SECRET_ACCESS_KEY?.trim())
      && Boolean(process.env.S3_BUCKET?.trim())

    // Resolve logo/favicon paths from StoredFile registry (legacy columns dropped)
    const [companyLogoPath, companyFaviconPath] = await Promise.all([
      getStoredFilePath('SETTINGS_BRANDING', 'default', 'COMPANY_LOGO'),
      getStoredFilePath('SETTINGS_BRANDING', 'default', 'COMPANY_FAVICON'),
    ])

    const response = NextResponse.json({
      ...decryptedSettings,
      companyLogoPath: companyLogoPath || null,
      companyFaviconPath: companyFaviconPath || null,
      security: securitySettings,
      smtpConfigured,
      s3Configured,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error fetching settings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  // Check authentication
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult // Return 401/403 response
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeSettings')
  if (forbiddenAction) return forbiddenAction

  try {
    const body = await request.json()

    const {
      companyName,
      companyLogoMode,
      companyLogoUrl,
      companyFaviconMode,
      companyFaviconUrl,
      smtpServer,
      smtpPort,
      smtpUsername,
      smtpPassword,
      smtpFromAddress,
      smtpSecure,
      emailTrackingPixelsEnabled,
      appDomain,
      mainCompanyDomain,
      defaultPreviewResolutions,
      defaultPreviewResolution,
      defaultAllowClientDeleteComments,
      defaultEnableClientUploads,
      defaultAllowClientUploadFiles,
      defaultAllowAuthenticatedProjectSwitching,
      defaultMaxClientUploadAllocationMB,
      autoApproveProject,
      autoDeletePreviewsOnClose,
      excludeInternalIpsFromAnalytics,
      uploadChunkSizeMB,
      downloadChunkSizeMB,
      autoCloseApprovedProjectsEnabled,
      autoCloseApprovedProjectsAfterDays,
      adminNotificationSchedule,
      adminNotificationTime,
      adminNotificationDay,
      adminEmailProjectApproved,
      adminEmailInternalComments,
      adminEmailTaskComments,
      adminEmailInvoicePaid,
      adminEmailQuoteAccepted,
      adminEmailProjectKeyDates,
      adminEmailUserKeyDates,
      defaultClientNotificationSchedule,
      defaultClientNotificationTime,
      defaultClientNotificationDay,
      clientEmailProjectApproved,
      emailCustomFooterText,
      accentColor,
      accentTextMode,
      emailHeaderColor,
      emailHeaderTextMode,
      s3LocalBackupEnabled,
      s3LocalBackupCategories,
      aiProvider,
      aiOllamaUrl,
      aiOllamaModel,
      aiAnthropicModel,
      aiAnthropicApiKey,
      aiOpenaiModel,
      aiOpenaiApiKey,
      aiReplyDraftsEnabled,
      aiReplySignature,
      aiInstructions,
      aiPortfolio,
      transcriptionEnabled,
      transcriptionProvider,
      transcriptionWhisperUrl,
      transcriptionWhisperModel,
      transcriptionOpenaiApiKey,
      transcriptionOpenaiModel,
      transcriptionLanguage,
      transcriptionMaxCharsPerLine,
      transcriptionMaxLines,
    } = body

    // SECURITY: Validate AI assistant settings
    if (aiProvider !== undefined && aiProvider !== null) {
      const validProviders = ['NONE', 'OLLAMA', 'ANTHROPIC', 'OPENAI']
      if (!validProviders.includes(aiProvider)) {
        return NextResponse.json(
          { error: 'Invalid aiProvider. Must be NONE, OLLAMA, ANTHROPIC, or OPENAI.' },
          { status: 400 }
        )
      }
    }

    if (transcriptionProvider !== undefined && transcriptionProvider !== null) {
      if (!['LOCAL', 'OPENAI'].includes(transcriptionProvider)) {
        return NextResponse.json(
          { error: 'Invalid transcriptionProvider. Must be LOCAL or OPENAI.' },
          { status: 400 }
        )
      }
    }

    for (const [field, value] of [
      ['transcriptionMaxCharsPerLine', transcriptionMaxCharsPerLine],
      ['transcriptionMaxLines', transcriptionMaxLines],
    ] as const) {
      if (value !== undefined && value !== null) {
        if (!Number.isInteger(value) || value < 0 || value > 200) {
          return NextResponse.json(
            { error: `Invalid ${field}. Must be an integer between 0 and 200.` },
            { status: 400 }
          )
        }
      }
    }

    if (aiOllamaUrl !== undefined && aiOllamaUrl !== null && aiOllamaUrl !== '') {
      const trimmedOllamaUrl = typeof aiOllamaUrl === 'string' ? aiOllamaUrl.trim() : ''
      let ollamaUrlValid = false
      try {
        const parsedUrl = new URL(trimmedOllamaUrl)
        ollamaUrlValid = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
      } catch {
        ollamaUrlValid = false
      }
      if (!ollamaUrlValid) {
        return NextResponse.json(
          { error: 'Invalid aiOllamaUrl. Must be an http(s) URL, e.g. http://127.0.0.1:11434.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate Whisper transcription settings
    if (transcriptionEnabled !== undefined && typeof transcriptionEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid value for transcriptionEnabled. Must be a boolean.' },
        { status: 400 }
      )
    }

    if (transcriptionWhisperUrl !== undefined && transcriptionWhisperUrl !== null && transcriptionWhisperUrl !== '') {
      const trimmedWhisperUrl = typeof transcriptionWhisperUrl === 'string' ? transcriptionWhisperUrl.trim() : ''
      let whisperUrlValid = false
      try {
        const parsedUrl = new URL(trimmedWhisperUrl)
        whisperUrlValid = (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') && trimmedWhisperUrl.length <= 500
      } catch {
        whisperUrlValid = false
      }
      if (!whisperUrlValid) {
        return NextResponse.json(
          { error: 'Invalid transcriptionWhisperUrl. Must be an http(s) URL, e.g. http://127.0.0.1:8000.' },
          { status: 400 }
        )
      }
    }

    if (transcriptionWhisperModel !== undefined && transcriptionWhisperModel !== null && typeof transcriptionWhisperModel !== 'string') {
      return NextResponse.json(
        { error: 'Invalid transcriptionWhisperModel. Must be a string.' },
        { status: 400 }
      )
    }

    if (transcriptionLanguage !== undefined && transcriptionLanguage !== null) {
      if (typeof transcriptionLanguage !== 'string' || transcriptionLanguage.trim().length > 10) {
        return NextResponse.json(
          { error: 'Invalid transcriptionLanguage. Must be a short language code like "en", or empty for autodetect.' },
          { status: 400 }
        )
      }
    }

    // Validate + normalize the AI portfolio library (array of {id,title,url,description})
    let aiPortfolioJson: string | undefined
    if (aiPortfolio !== undefined) {
      if (!Array.isArray(aiPortfolio)) {
        return NextResponse.json({ error: 'aiPortfolio must be an array.' }, { status: 400 })
      }
      if (aiPortfolio.length > 200) {
        return NextResponse.json({ error: 'Too many portfolio items (max 200).' }, { status: 400 })
      }
      const normalized = []
      for (const raw of aiPortfolio) {
        const title = typeof raw?.title === 'string' ? raw.title.trim() : ''
        const url = typeof raw?.url === 'string' ? raw.url.trim() : ''
        if (!title || !url) continue // drop incomplete rows
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return NextResponse.json({ error: `Portfolio URL must be http(s): "${url}"` }, { status: 400 })
          }
        } catch {
          return NextResponse.json({ error: `Invalid portfolio URL: "${url}"` }, { status: 400 })
        }
        normalized.push({
          id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : `pf-${normalized.length + 1}`,
          title: title.slice(0, 300),
          url: url.slice(0, 2000),
          description: typeof raw?.description === 'string' ? raw.description.trim().slice(0, 500) : '',
        })
      }
      aiPortfolioJson = JSON.stringify(normalized)
    }

    // SECURITY: Validate auto-close settings
    if (autoCloseApprovedProjectsEnabled !== undefined && typeof autoCloseApprovedProjectsEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid value for autoCloseApprovedProjectsEnabled. Must be a boolean.' },
        { status: 400 }
      )
    }

    if (autoCloseApprovedProjectsAfterDays !== undefined && autoCloseApprovedProjectsAfterDays !== null) {
      if (!Number.isInteger(autoCloseApprovedProjectsAfterDays) || autoCloseApprovedProjectsAfterDays < 1 || autoCloseApprovedProjectsAfterDays > 99) {
        return NextResponse.json(
          { error: 'Invalid value for autoCloseApprovedProjectsAfterDays. Must be an integer between 1 and 99.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate companyLogoMode
    if (companyLogoMode !== undefined && companyLogoMode !== null) {
      const validModes = ['NONE', 'UPLOAD', 'LINK']
      if (!validModes.includes(companyLogoMode)) {
        return NextResponse.json(
          { error: 'Invalid companyLogoMode. Must be NONE, UPLOAD, or LINK.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate companyFaviconMode
    if (companyFaviconMode !== undefined && companyFaviconMode !== null) {
      const validModes = ['NONE', 'UPLOAD', 'LINK']
      if (!validModes.includes(companyFaviconMode)) {
        return NextResponse.json(
          { error: 'Invalid companyFaviconMode. Must be NONE, UPLOAD, or LINK.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate companyLogoUrl when using LINK mode
    if (companyLogoMode === 'LINK') {
      const url = typeof companyLogoUrl === 'string' ? companyLogoUrl.trim() : ''
      if (!url) {
        return NextResponse.json(
          { error: 'companyLogoUrl is required when companyLogoMode is LINK.' },
          { status: 400 }
        )
      }

      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return NextResponse.json(
            { error: 'companyLogoUrl must start with http:// or https://.' },
            { status: 400 }
          )
        }
      } catch {
        return NextResponse.json(
          { error: 'Invalid companyLogoUrl. Please enter a valid URL.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate companyFaviconUrl when using LINK mode
    if (companyFaviconMode === 'LINK') {
      const url = typeof companyFaviconUrl === 'string' ? companyFaviconUrl.trim() : ''
      if (!url) {
        return NextResponse.json(
          { error: 'companyFaviconUrl is required when companyFaviconMode is LINK.' },
          { status: 400 }
        )
      }

      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return NextResponse.json(
            { error: 'companyFaviconUrl must start with http:// or https://.' },
            { status: 400 }
          )
        }
      } catch {
        return NextResponse.json(
          { error: 'Invalid companyFaviconUrl. Please enter a valid URL.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate emailTrackingPixelsEnabled is boolean
    if (emailTrackingPixelsEnabled !== undefined && typeof emailTrackingPixelsEnabled !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid value for emailTrackingPixelsEnabled. Must be a boolean.' },
        { status: 400 }
      )
    }

    // SECURITY: Validate notification schedule
    if (adminNotificationSchedule !== undefined) {
      const validSchedules = ['IMMEDIATE', 'HOURLY', 'DAILY', 'NONE']
      if (!validSchedules.includes(adminNotificationSchedule)) {
        return NextResponse.json(
          { error: 'Invalid notification schedule. Must be IMMEDIATE, HOURLY, DAILY, or NONE.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate defaultClientNotificationSchedule
    if (defaultClientNotificationSchedule !== undefined) {
      const validSchedules = ['IMMEDIATE', 'HOURLY', 'DAILY', 'NONE']
      if (!validSchedules.includes(defaultClientNotificationSchedule)) {
        return NextResponse.json(
          { error: 'Invalid defaultClientNotificationSchedule. Must be IMMEDIATE, HOURLY, DAILY, or NONE.' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate time format (HH:MM)
    if (adminNotificationTime !== undefined && adminNotificationTime !== null) {
      const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/
      if (!timeRegex.test(adminNotificationTime)) {
        return NextResponse.json(
          { error: 'Invalid time format. Must be HH:MM (24-hour format).' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate day (0-6)
    if (adminNotificationDay !== undefined && adminNotificationDay !== null) {
      if (!Number.isInteger(adminNotificationDay) || adminNotificationDay < 0 || adminNotificationDay > 6) {
        return NextResponse.json(
          { error: 'Invalid day. Must be 0-6 (Sunday-Saturday).' },
          { status: 400 }
        )
      }
    }

    // SECURITY: Validate defaultMaxClientUploadAllocationMB
    if (defaultMaxClientUploadAllocationMB !== undefined && defaultMaxClientUploadAllocationMB !== null) {
      if (!Number.isInteger(defaultMaxClientUploadAllocationMB) || defaultMaxClientUploadAllocationMB < 0 || defaultMaxClientUploadAllocationMB > 1000000) {
        return NextResponse.json(
          { error: 'Invalid value for defaultMaxClientUploadAllocationMB. Must be an integer between 0 and 1,000,000.' },
          { status: 400 }
        )
      }
    }

    if (defaultAllowAuthenticatedProjectSwitching !== undefined && typeof defaultAllowAuthenticatedProjectSwitching !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid value for defaultAllowAuthenticatedProjectSwitching. Must be a boolean.' },
        { status: 400 }
      )
    }

    if (uploadChunkSizeMB !== undefined && uploadChunkSizeMB !== null) {
      if (!Number.isInteger(uploadChunkSizeMB) || uploadChunkSizeMB < MIN_UPLOAD_CHUNK_SIZE_MB || uploadChunkSizeMB > MAX_UPLOAD_CHUNK_SIZE_MB) {
        return NextResponse.json(
          { error: `Invalid value for uploadChunkSizeMB. Must be an integer between ${MIN_UPLOAD_CHUNK_SIZE_MB} and ${MAX_UPLOAD_CHUNK_SIZE_MB}.` },
          { status: 400 }
        )
      }
    }

    if (downloadChunkSizeMB !== undefined && downloadChunkSizeMB !== null) {
      if (!Number.isInteger(downloadChunkSizeMB) || downloadChunkSizeMB < MIN_DOWNLOAD_CHUNK_SIZE_MB || downloadChunkSizeMB > MAX_DOWNLOAD_CHUNK_SIZE_MB) {
        return NextResponse.json(
          { error: `Invalid value for downloadChunkSizeMB. Must be an integer between ${MIN_DOWNLOAD_CHUNK_SIZE_MB} and ${MAX_DOWNLOAD_CHUNK_SIZE_MB}.` },
          { status: 400 }
        )
      }
    }

    // Handle SMTP password update - only update if actually changed
    let passwordUpdate: string | null | undefined
    if (smtpPassword !== undefined) {
      // Get current settings to compare password
      const currentSettings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { smtpPassword: true },
      })

      // Decrypt current password for comparison
      const currentPassword = currentSettings?.smtpPassword ? decrypt(currentSettings.smtpPassword) : null

      // Only update if password actually changed
      if (smtpPassword === null || smtpPassword === '') {
        // Clearing password
        if (currentPassword !== null) {
          passwordUpdate = null
        } else {
          passwordUpdate = undefined // Already null, don't update
        }
      } else {
        // Setting/updating password - only if different from current
        if (smtpPassword !== currentPassword) {
          passwordUpdate = encrypt(smtpPassword)
        } else {
          passwordUpdate = undefined // Same password, don't update
        }
      }
    } else {
      // Password not provided in request, don't update
      passwordUpdate = undefined
    }

    // Handle AI API key update - only update if actually changed (mirrors smtpPassword)
    let aiApiKeyUpdate: string | null | undefined
    if (aiAnthropicApiKey !== undefined) {
      const currentAiSettings = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { aiAnthropicApiKey: true },
      })
      const currentAiKey = currentAiSettings?.aiAnthropicApiKey ? decrypt(currentAiSettings.aiAnthropicApiKey) : null

      if (aiAnthropicApiKey === null || aiAnthropicApiKey === '') {
        aiApiKeyUpdate = currentAiKey !== null ? null : undefined
      } else if (aiAnthropicApiKey !== currentAiKey) {
        aiApiKeyUpdate = encrypt(aiAnthropicApiKey)
      } else {
        aiApiKeyUpdate = undefined
      }
    } else {
      aiApiKeyUpdate = undefined
    }

    // Same "encrypt only if changed" logic for the two OpenAI keys (assistant + transcription)
    async function resolveEncryptedKeyUpdate(
      incoming: unknown,
      column: 'aiOpenaiApiKey' | 'transcriptionOpenaiApiKey',
    ): Promise<string | null | undefined> {
      if (incoming === undefined) return undefined
      const current = await prisma.settings.findUnique({
        where: { id: 'default' },
        select: { [column]: true } as Record<string, true>,
      })
      const stored = (current as Record<string, string | null> | null)?.[column] ?? null
      const currentKey = stored ? decrypt(stored) : null
      if (incoming === null || incoming === '') return currentKey !== null ? null : undefined
      if (typeof incoming === 'string' && incoming !== currentKey) return encrypt(incoming)
      return undefined
    }
    const aiOpenaiApiKeyUpdate = await resolveEncryptedKeyUpdate(aiOpenaiApiKey, 'aiOpenaiApiKey')
    const transcriptionOpenaiApiKeyUpdate = await resolveEncryptedKeyUpdate(transcriptionOpenaiApiKey, 'transcriptionOpenaiApiKey')

    // Build update data (only include password if it should be updated)
    const updateData: any = {
      companyName,
      companyLogoMode,
      companyLogoUrl:
        companyLogoMode === 'LINK'
          ? (typeof companyLogoUrl === 'string' ? companyLogoUrl.trim() : null)
          : (companyLogoMode !== undefined ? null : undefined),
      companyFaviconMode,
      companyFaviconUrl:
        companyFaviconMode === 'LINK'
          ? (typeof companyFaviconUrl === 'string' ? companyFaviconUrl.trim() : null)
          : (companyFaviconMode !== undefined ? null : undefined),
      smtpServer,
      smtpPort: smtpPort ? parseInt(smtpPort, 10) : null,
      smtpUsername,
      smtpFromAddress,
      smtpSecure,
      emailTrackingPixelsEnabled,
      appDomain,
      mainCompanyDomain,
      defaultPreviewResolutions: defaultPreviewResolutions !== undefined
        ? JSON.stringify(defaultPreviewResolutions)
        : (defaultPreviewResolution !== undefined ? JSON.stringify([defaultPreviewResolution]) : undefined),
      defaultAllowClientDeleteComments,
      defaultEnableClientUploads,
      defaultAllowClientUploadFiles,
      defaultAllowAuthenticatedProjectSwitching,
      defaultMaxClientUploadAllocationMB,
      autoApproveProject,
      uploadChunkSizeMB: uploadChunkSizeMB !== undefined ? normalizeUploadChunkSizeMB(uploadChunkSizeMB) : undefined,
      downloadChunkSizeMB: downloadChunkSizeMB !== undefined ? normalizeDownloadChunkSizeMB(downloadChunkSizeMB) : undefined,
      autoDeletePreviewsOnClose: typeof autoDeletePreviewsOnClose === 'boolean' ? autoDeletePreviewsOnClose : undefined,
      excludeInternalIpsFromAnalytics: typeof excludeInternalIpsFromAnalytics === 'boolean' ? excludeInternalIpsFromAnalytics : undefined,
      autoCloseApprovedProjectsEnabled,
      autoCloseApprovedProjectsAfterDays,
      adminNotificationSchedule,
      adminNotificationTime,
      adminNotificationDay: adminNotificationDay !== undefined ? adminNotificationDay : null,
      adminEmailProjectApproved: typeof adminEmailProjectApproved === 'boolean' ? adminEmailProjectApproved : undefined,
      adminEmailInternalComments: typeof adminEmailInternalComments === 'boolean' ? adminEmailInternalComments : undefined,
      adminEmailTaskComments: typeof adminEmailTaskComments === 'boolean' ? adminEmailTaskComments : undefined,
      adminEmailInvoicePaid: typeof adminEmailInvoicePaid === 'boolean' ? adminEmailInvoicePaid : undefined,
      adminEmailQuoteAccepted: typeof adminEmailQuoteAccepted === 'boolean' ? adminEmailQuoteAccepted : undefined,
      adminEmailProjectKeyDates: typeof adminEmailProjectKeyDates === 'boolean' ? adminEmailProjectKeyDates : undefined,
      adminEmailUserKeyDates: typeof adminEmailUserKeyDates === 'boolean' ? adminEmailUserKeyDates : undefined,
      defaultClientNotificationSchedule,
      defaultClientNotificationTime,
      defaultClientNotificationDay: defaultClientNotificationDay !== undefined ? defaultClientNotificationDay : null,
      clientEmailProjectApproved: typeof clientEmailProjectApproved === 'boolean' ? clientEmailProjectApproved : undefined,
      emailCustomFooterText,
      accentColor: typeof accentColor === 'string' ? (accentColor.trim() || null) : accentColor,
      accentTextMode: accentTextMode === 'LIGHT' || accentTextMode === 'DARK' ? accentTextMode : undefined,
      emailHeaderColor: typeof emailHeaderColor === 'string' ? (emailHeaderColor.trim() || null) : emailHeaderColor,
      emailHeaderTextMode: emailHeaderTextMode === 'LIGHT' || emailHeaderTextMode === 'DARK' ? emailHeaderTextMode : undefined,
      s3LocalBackupEnabled: typeof s3LocalBackupEnabled === 'boolean' ? s3LocalBackupEnabled : undefined,
      s3LocalBackupCategories: Array.isArray(s3LocalBackupCategories) ? JSON.stringify(s3LocalBackupCategories) : undefined,
      aiProvider,
      aiOllamaUrl: typeof aiOllamaUrl === 'string' ? (aiOllamaUrl.trim() || null) : aiOllamaUrl,
      aiOllamaModel: typeof aiOllamaModel === 'string' ? (aiOllamaModel.trim() || null) : aiOllamaModel,
      aiAnthropicModel: typeof aiAnthropicModel === 'string' ? (aiAnthropicModel.trim() || null) : aiAnthropicModel,
      aiOpenaiModel: typeof aiOpenaiModel === 'string' ? (aiOpenaiModel.trim() || null) : aiOpenaiModel,
      aiReplyDraftsEnabled: typeof aiReplyDraftsEnabled === 'boolean' ? aiReplyDraftsEnabled : undefined,
      aiReplySignature: typeof aiReplySignature === 'string' ? (aiReplySignature.trim() || null) : aiReplySignature,
      aiInstructions: typeof aiInstructions === 'string' ? (aiInstructions.trim() || null) : aiInstructions,
      aiPortfolioJson,
      transcriptionEnabled: typeof transcriptionEnabled === 'boolean' ? transcriptionEnabled : undefined,
      transcriptionProvider: transcriptionProvider === 'LOCAL' || transcriptionProvider === 'OPENAI' ? transcriptionProvider : undefined,
      transcriptionWhisperUrl: typeof transcriptionWhisperUrl === 'string' ? (transcriptionWhisperUrl.trim() || null) : transcriptionWhisperUrl,
      transcriptionWhisperModel: typeof transcriptionWhisperModel === 'string' ? (transcriptionWhisperModel.trim().slice(0, 200) || null) : transcriptionWhisperModel,
      transcriptionOpenaiModel: typeof transcriptionOpenaiModel === 'string' ? (transcriptionOpenaiModel.trim().slice(0, 100) || null) : transcriptionOpenaiModel,
      transcriptionLanguage: typeof transcriptionLanguage === 'string' ? (transcriptionLanguage.trim() || null) : transcriptionLanguage,
      transcriptionMaxCharsPerLine: Number.isInteger(transcriptionMaxCharsPerLine) ? transcriptionMaxCharsPerLine : undefined,
      transcriptionMaxLines: Number.isInteger(transcriptionMaxLines) ? transcriptionMaxLines : undefined,
    }

    // Only update password if it's not the placeholder
    if (passwordUpdate !== undefined) {
      updateData.smtpPassword = passwordUpdate
    }

    // Only update the AI API keys if they actually changed
    if (aiApiKeyUpdate !== undefined) {
      updateData.aiAnthropicApiKey = aiApiKeyUpdate
    }
    if (aiOpenaiApiKeyUpdate !== undefined) {
      updateData.aiOpenaiApiKey = aiOpenaiApiKeyUpdate
    }
    if (transcriptionOpenaiApiKeyUpdate !== undefined) {
      updateData.transcriptionOpenaiApiKey = transcriptionOpenaiApiKeyUpdate
    }

    // Update or create the settings
    const settings = await prisma.settings.upsert({
      where: { id: 'default' },
      update: updateData,
      create: {
        id: 'default',
        companyName,
        companyLogoMode: companyLogoMode || 'NONE',
        companyLogoUrl:
          companyLogoMode === 'LINK'
            ? (typeof companyLogoUrl === 'string' ? companyLogoUrl.trim() : null)
            : null,
        companyFaviconMode: companyFaviconMode || 'NONE',
        companyFaviconUrl:
          companyFaviconMode === 'LINK'
            ? (typeof companyFaviconUrl === 'string' ? companyFaviconUrl.trim() : null)
            : null,
        smtpServer,
        smtpPort: smtpPort ? parseInt(smtpPort, 10) : null,
        smtpUsername,
        smtpPassword: passwordUpdate || null,
        smtpFromAddress,
        smtpSecure,
        emailTrackingPixelsEnabled: emailTrackingPixelsEnabled ?? true,
        emailCustomFooterText,
        appDomain,
        defaultPreviewResolutions: defaultPreviewResolutions !== undefined
          ? JSON.stringify(defaultPreviewResolutions)
          : (defaultPreviewResolution !== undefined ? JSON.stringify([defaultPreviewResolution]) : '["720p"]'),
        defaultAllowClientDeleteComments,
        defaultEnableClientUploads,
        defaultAllowClientUploadFiles,
        defaultAllowAuthenticatedProjectSwitching,
        autoApproveProject,
        uploadChunkSizeMB: normalizeUploadChunkSizeMB(uploadChunkSizeMB),
        downloadChunkSizeMB: normalizeDownloadChunkSizeMB(downloadChunkSizeMB),
        excludeInternalIpsFromAnalytics: typeof excludeInternalIpsFromAnalytics === 'boolean' ? excludeInternalIpsFromAnalytics : true,
        autoCloseApprovedProjectsEnabled,
        autoCloseApprovedProjectsAfterDays,
        adminNotificationSchedule: adminNotificationSchedule || 'IMMEDIATE',
        adminNotificationTime,
        adminNotificationDay: adminNotificationDay !== undefined ? adminNotificationDay : null,
      },
    })

    // Ensure future emails pick up updated settings immediately
  invalidateSettingsCaches()
    invalidateEmailSettingsCache()

    // Decrypt sensitive fields before sending to admin
    const { accountingFilesBytes: _accountingFilesBytes2, ...settingsForClient2 } = settings
    const decryptedSettings = {
      ...settingsForClient2,
      smtpPassword: settings.smtpPassword ? decrypt(settings.smtpPassword) : null,
      aiAnthropicApiKey: settings.aiAnthropicApiKey ? decrypt(settings.aiAnthropicApiKey) : null,
      aiOpenaiApiKey: settings.aiOpenaiApiKey ? decrypt(settings.aiOpenaiApiKey) : null,
      transcriptionOpenaiApiKey: settings.transcriptionOpenaiApiKey ? decrypt(settings.transcriptionOpenaiApiKey) : null,
      aiPortfolio: (() => {
        try {
          const arr = JSON.parse(settings.aiPortfolioJson || '[]')
          return Array.isArray(arr) ? arr : []
        } catch {
          return []
        }
      })(),
    }

    const response = NextResponse.json(decryptedSettings)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error updating settings:', error)
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    )
  }
}
