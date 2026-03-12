import { prisma } from './db'
import {
  BYTES_PER_MB,
  DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
  DEFAULT_UPLOAD_CHUNK_SIZE_MB,
  normalizeDownloadChunkSizeMB,
  normalizeUploadChunkSizeMB,
} from './transfer-tuning'

// Simple in-memory cache for frequently read settings to avoid repeated DB hits
const SETTINGS_CACHE_TTL_MS = 60_000
type CachedValue<T> = { value: T; expiresAt: number }
const cachedRateLimits: CachedValue<{
  ipRateLimit: number
  sessionRateLimit: number
  shareSessionRateLimit?: number
  shareTokenTtlSeconds?: number
}> = { value: { ipRateLimit: 1000, sessionRateLimit: 600 }, expiresAt: 0 }
const cachedSessionTimeout: CachedValue<number> = { value: 15 * 60, expiresAt: 0 }
const cachedSmtpConfigured: CachedValue<boolean> = { value: false, expiresAt: 0 }
const cachedAutoApproveProject: CachedValue<boolean> = { value: true, expiresAt: 0 }
const cachedExcludeInternalIpsFromAnalytics: CachedValue<boolean> = { value: true, expiresAt: 0 }
const cachedTransferTuning: CachedValue<{ uploadChunkSizeMB: number; downloadChunkSizeMB: number }> = {
  value: {
    uploadChunkSizeMB: DEFAULT_UPLOAD_CHUNK_SIZE_MB,
    downloadChunkSizeMB: DEFAULT_DOWNLOAD_CHUNK_SIZE_MB,
  },
  expiresAt: 0,
}
type SafeguardLimits = {
  maxInternalCommentsPerProject: number
  maxCommentsPerVideoVersion: number
  maxProjectRecipients: number
  maxProjectFilesPerProject: number
}
const cachedSafeguardLimits: CachedValue<SafeguardLimits> = {
  value: {
    maxInternalCommentsPerProject: 250,
    maxCommentsPerVideoVersion: 100,
    maxProjectRecipients: 30,
    maxProjectFilesPerProject: 50,
  },
  expiresAt: 0,
}

export function invalidateSecuritySettingsCaches() {
  cachedRateLimits.expiresAt = 0
  cachedSessionTimeout.expiresAt = 0
  cachedSafeguardLimits.expiresAt = 0
}

export function invalidateSettingsCaches() {
  cachedSmtpConfigured.expiresAt = 0
  cachedAutoApproveProject.expiresAt = 0
  cachedExcludeInternalIpsFromAnalytics.expiresAt = 0
  cachedTransferTuning.expiresAt = 0
}

/**
 * Get the company name from settings
 * Returns 'Studio' as default if not set
 */
export async function getCompanyName(): Promise<string> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { companyName: true },
    })

    return settings?.companyName || 'Studio'
  } catch (error) {
    console.error('Error fetching company name:', error)
    return 'Studio' // Fallback to default
  }
}

/**
 * Get all settings
 */
export async function getSettings() {
  try {
    let settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    })

    if (!settings) {
      // Create default settings if they don't exist
      settings = await prisma.settings.create({
        data: {
          id: 'default',
          companyName: 'Studio',
        },
      })
    }

    return settings
  } catch (error) {
    console.error('Error fetching settings:', error)
    return null
  }
}

/**
 * Check if SMTP is configured
 */
export async function isSmtpConfigured(): Promise<boolean> {
  const now = Date.now()
  if (cachedSmtpConfigured.expiresAt > now) {
    return cachedSmtpConfigured.value
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        smtpServer: true,
        smtpPort: true,
        smtpUsername: true,
        smtpPassword: true,
      },
    })

    const configured = !!(settings?.smtpServer && settings?.smtpPort && settings?.smtpUsername && settings?.smtpPassword)
    cachedSmtpConfigured.value = configured
    cachedSmtpConfigured.expiresAt = now + SETTINGS_CACHE_TTL_MS

    return configured
  } catch (error) {
    console.error('Error checking SMTP configuration:', error)
    return cachedSmtpConfigured.value
  }
}

/**
 * Check if auto-approve project when all videos approved is enabled
 * Returns true as default if not set
 */
export async function getAutoApproveProject(): Promise<boolean> {
  const now = Date.now()
  if (cachedAutoApproveProject.expiresAt > now) {
    return cachedAutoApproveProject.value
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { autoApproveProject: true },
    })

    const value = settings?.autoApproveProject ?? true
    cachedAutoApproveProject.value = value
    cachedAutoApproveProject.expiresAt = now + SETTINGS_CACHE_TTL_MS
    return value
  } catch (error) {
    console.error('Error fetching auto-approve setting:', error)
    return cachedAutoApproveProject.value
  }
}

export async function shouldExcludeInternalIpsFromAnalytics(): Promise<boolean> {
  const now = Date.now()
  if (cachedExcludeInternalIpsFromAnalytics.expiresAt > now) {
    return cachedExcludeInternalIpsFromAnalytics.value
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { excludeInternalIpsFromAnalytics: true },
    })

    const value = settings?.excludeInternalIpsFromAnalytics ?? true
    cachedExcludeInternalIpsFromAnalytics.value = value
    cachedExcludeInternalIpsFromAnalytics.expiresAt = now + SETTINGS_CACHE_TTL_MS
    return value
  } catch (error) {
    console.error('Error fetching internal IP analytics exclusion setting:', error)
    return cachedExcludeInternalIpsFromAnalytics.value
  }
}

export async function getTransferTuningSettings(): Promise<{
  uploadChunkSizeMB: number
  uploadChunkSizeBytes: number
  downloadChunkSizeMB: number
  downloadChunkSizeBytes: number
}> {
  const now = Date.now()
  if (cachedTransferTuning.expiresAt > now) {
    const { uploadChunkSizeMB, downloadChunkSizeMB } = cachedTransferTuning.value
    return {
      uploadChunkSizeMB,
      uploadChunkSizeBytes: uploadChunkSizeMB * BYTES_PER_MB,
      downloadChunkSizeMB,
      downloadChunkSizeBytes: downloadChunkSizeMB * BYTES_PER_MB,
    }
  }

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        uploadChunkSizeMB: true,
        downloadChunkSizeMB: true,
      },
    })

    const uploadChunkSizeMB = normalizeUploadChunkSizeMB(settings?.uploadChunkSizeMB)
    const downloadChunkSizeMB = normalizeDownloadChunkSizeMB(settings?.downloadChunkSizeMB)

    cachedTransferTuning.value = { uploadChunkSizeMB, downloadChunkSizeMB }
    cachedTransferTuning.expiresAt = now + SETTINGS_CACHE_TTL_MS

    return {
      uploadChunkSizeMB,
      uploadChunkSizeBytes: uploadChunkSizeMB * BYTES_PER_MB,
      downloadChunkSizeMB,
      downloadChunkSizeBytes: downloadChunkSizeMB * BYTES_PER_MB,
    }
  } catch (error) {
    console.error('Error fetching transfer tuning settings:', error)
    const { uploadChunkSizeMB, downloadChunkSizeMB } = cachedTransferTuning.value
    return {
      uploadChunkSizeMB,
      uploadChunkSizeBytes: uploadChunkSizeMB * BYTES_PER_MB,
      downloadChunkSizeMB,
      downloadChunkSizeBytes: downloadChunkSizeMB * BYTES_PER_MB,
    }
  }
}

export async function getSafeguardLimits(): Promise<SafeguardLimits> {
  const now = Date.now()
  if (cachedSafeguardLimits.expiresAt > now) {
    return cachedSafeguardLimits.value
  }

  try {
    const settings = await prisma.securitySettings.findUnique({
      where: { id: 'default' },
      select: {
        maxInternalCommentsPerProject: true,
        maxCommentsPerVideoVersion: true,
        maxProjectRecipients: true,
        maxProjectFilesPerProject: true,
      },
    })

    cachedSafeguardLimits.value = {
      maxInternalCommentsPerProject: settings?.maxInternalCommentsPerProject ?? 250,
      maxCommentsPerVideoVersion: settings?.maxCommentsPerVideoVersion ?? 100,
      maxProjectRecipients: settings?.maxProjectRecipients ?? 30,
      maxProjectFilesPerProject: settings?.maxProjectFilesPerProject ?? 50,
    }
    cachedSafeguardLimits.expiresAt = now + SETTINGS_CACHE_TTL_MS
    return cachedSafeguardLimits.value
  } catch (error) {
    console.error('Error fetching safeguard limits:', error)
    return cachedSafeguardLimits.value
  }
}

/**
 * Get client session timeout in seconds from security settings
 * Used for:
 * - Share token TTL guidance
 * - Video access token TTL
 * - Redis session mappings for content streaming
 *
 * NOT used for admin JWT sessions (those stay fixed at 30 min with auto-refresh)
 */
export async function getClientSessionTimeoutSeconds(): Promise<number> {
  const now = Date.now()
  if (cachedSessionTimeout.expiresAt > now) {
    return cachedSessionTimeout.value
  }

  try {
    const settings = await prisma.securitySettings.findUnique({
      where: { id: 'default' },
      select: {
        sessionTimeoutValue: true,
        sessionTimeoutUnit: true,
      },
    })

    if (!settings) {
      cachedSessionTimeout.value = 15 * 60
      cachedSessionTimeout.expiresAt = now + SETTINGS_CACHE_TTL_MS
      return cachedSessionTimeout.value
    }

    const value = settings.sessionTimeoutValue
    const unit = settings.sessionTimeoutUnit

    // Convert to seconds based on unit
    switch (unit) {
      case 'MINUTES':
        cachedSessionTimeout.value = value * 60
        break
      case 'HOURS':
        cachedSessionTimeout.value = value * 60 * 60
        break
      case 'DAYS':
        cachedSessionTimeout.value = value * 24 * 60 * 60
        break
      case 'WEEKS':
        cachedSessionTimeout.value = value * 7 * 24 * 60 * 60
        break
      default:
        cachedSessionTimeout.value = 15 * 60
        break
    }

    cachedSessionTimeout.expiresAt = now + SETTINGS_CACHE_TTL_MS
    return cachedSessionTimeout.value
  } catch (error) {
    console.error('Error fetching client session timeout:', error)
    return cachedSessionTimeout.value
  }
}

/**
 * Initialize security settings on container startup.
 * Ensures default security settings row exists in the database.
 */
export async function initializeSecuritySettings() {
  try {
    // Ensure the security settings row exists (does not overwrite existing values)
    await prisma.securitySettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default' },
    })

    const httpsMode = isHttpsEnabled()
    console.log(`[INIT] HTTPS mode: ${httpsMode ? 'enabled' : 'disabled'} (from HTTPS_ENABLED env var, default: false)`)
  } catch (error) {
    console.error('[INIT] Error initializing security settings:', error)
  }
}

export async function getMaxAuthAttempts(): Promise<number> {
  try {
    const securitySettings = await prisma.securitySettings.findUnique({
      where: { id: 'default' },
      select: { passwordAttempts: true }
    })
    return securitySettings?.passwordAttempts || 5
  } catch (error) {
    return 5 // Default fallback
  }
}

/**
 * Check if HTTPS mode is enabled.
 *
 * Single source of truth: the HTTPS_ENABLED environment variable.
 * This controls both transport headers (via next.config.js at startup)
 * and passkey/WebAuthn origin validation (via this function at runtime).
 *
 * Default: false (safe for local/HTTP development).
 * Set HTTPS_ENABLED=true in docker-compose for production HTTPS deployments.
 */
export function isHttpsEnabled(): boolean {
  const envValue = process.env.HTTPS_ENABLED
  return envValue === 'true' || envValue === '1'
}

export async function getRateLimitSettings(): Promise<{
  ipRateLimit: number
  sessionRateLimit: number
  shareSessionRateLimit?: number
  shareTokenTtlSeconds?: number
}> {
  const now = Date.now()
  if (cachedRateLimits.expiresAt > now) {
    return cachedRateLimits.value
  }

  try {
    const settings = await prisma.securitySettings.findUnique({
      where: { id: 'default' },
      select: {
        ipRateLimit: true,
        sessionRateLimit: true,
        shareSessionRateLimit: true,
        shareTokenTtlSeconds: true,
      },
    })

    cachedRateLimits.value = {
      ipRateLimit: settings?.ipRateLimit ?? 1000,
      sessionRateLimit: settings?.sessionRateLimit ?? 600,
      shareSessionRateLimit: settings?.shareSessionRateLimit ?? 300,
      shareTokenTtlSeconds: settings?.shareTokenTtlSeconds ?? undefined,
    }
    cachedRateLimits.expiresAt = now + SETTINGS_CACHE_TTL_MS

    return cachedRateLimits.value
  } catch (error) {
    return cachedRateLimits.value
  }
}

/**
 * Share token TTL (seconds)
 * Uses the same client session timeout setting to keep share JWTs aligned with content access TTLs.
 */
export async function getShareTokenTtlSeconds(): Promise<number> {
  const { shareTokenTtlSeconds } = await getRateLimitSettings()
  if (shareTokenTtlSeconds && shareTokenTtlSeconds > 0) {
    return shareTokenTtlSeconds
  }
  return getClientSessionTimeoutSeconds()
}

/**
 * Get WebAuthn Relying Party configuration from settings
 *
 * SECURITY: Throws error if appDomain is not configured
 * PassKey authentication REQUIRES proper domain configuration
 *
 * @returns RP_ID and origin(s) for WebAuthn operations
 */
export async function getWebAuthnConfig(): Promise<{
  rpID: string
  rpName: string
  origins: string[]
}> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        appDomain: true,
        companyName: true,
      },
    })

    if (!settings?.appDomain) {
      throw new Error(
        'PASSKEY_CONFIG_ERROR: Application Domain must be configured in Settings before using PassKey authentication. ' +
        'Go to Admin Settings and configure your domain (e.g., https://yourdomain.com)'
      )
    }

    // Parse and validate domain
    let url: URL
    try {
      url = new URL(settings.appDomain)
    } catch {
      throw new Error(
        `PASSKEY_CONFIG_ERROR: Invalid appDomain format: "${settings.appDomain}". ` +
        'Must be a valid URL (e.g., https://yourdomain.com)'
      )
    }

    // RP_ID is the hostname without protocol or port
    const rpID = url.hostname

    // Origin is the full protocol + hostname + port (if non-standard)
    const origin = url.origin

    // Support localhost for development
    const origins = [origin]
    if (rpID === 'localhost' || rpID === '127.0.0.1') {
      // Allow both localhost and 127.0.0.1 for development
      origins.push('http://localhost:3000', 'http://127.0.0.1:3000')
    }

    return {
      rpID,
      rpName: settings.companyName || 'ViTransfer',
      origins,
    }
  } catch (error) {
    // Re-throw configuration errors
    if (error instanceof Error && error.message.startsWith('PASSKEY_CONFIG_ERROR')) {
      throw error
    }

    console.error('Error fetching WebAuthn config:', error)
    throw new Error('Failed to retrieve PassKey configuration. Please check Settings.')
  }
}

/**
 * Check if PassKey authentication is properly configured
 *
 * STRICT VALIDATION:
 * - Production: Real domain + HTTPS enabled
 * - Development: Localhost + HTTPS disabled
 * - NO MIXED CONFIGURATIONS (localhost+HTTPS or domain+no-HTTPS)
 *
 * Returns false if appDomain is not set or configuration is invalid
 */
export async function isPasskeyConfigured(): Promise<boolean> {
  try {
    const config = await getWebAuthnConfig()
    const httpsEnabled = isHttpsEnabled()

    const isLocalhost =
      config.rpID === 'localhost' ||
      config.rpID === '127.0.0.1'

    // Valid configurations (no mixing):
    // 1. Production: Real domain + HTTPS enabled
    // 2. Development: Localhost + HTTPS disabled
    const isValidConfig =
      (!isLocalhost && httpsEnabled) ||
      (isLocalhost && !httpsEnabled)

    return isValidConfig
  } catch (error) {
    return false
  }
}

/**
 * Get detailed passkey configuration status
 * Used for admin UI to show why passkey is not available
 */
export async function getPasskeyConfigStatus(): Promise<{
  available: boolean
  reason?: string
  config?: {
    domain: string
    httpsEnabled: boolean
    isLocalhost: boolean
  }
}> {
  try {
    const config = await getWebAuthnConfig()
    const httpsEnabled = isHttpsEnabled()

    const isLocalhost =
      config.rpID === 'localhost' ||
      config.rpID === '127.0.0.1'

    // Early return for invalid localhost configuration
    if (isLocalhost && httpsEnabled) {
      return {
        available: false,
        reason: 'Invalid configuration: Localhost requires HTTPS to be disabled',
        config: {
          domain: config.rpID,
          httpsEnabled,
          isLocalhost,
        },
      }
    }

    // Early return for invalid production configuration
    if (!isLocalhost && !httpsEnabled) {
      return {
        available: false,
        reason: 'Invalid configuration: Production domain requires HTTPS to be enabled',
        config: {
          domain: config.rpID,
          httpsEnabled,
          isLocalhost,
        },
      }
    }

    // Valid configuration
    return {
      available: true,
      config: {
        domain: config.rpID,
        httpsEnabled,
        isLocalhost,
      },
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('PASSKEY_CONFIG_ERROR')) {
      return {
        available: false,
        reason: error.message.replace('PASSKEY_CONFIG_ERROR: ', ''),
      }
    }

    return {
      available: false,
      reason: 'Domain not configured. Set appDomain in Settings.',
    }
  }
}
