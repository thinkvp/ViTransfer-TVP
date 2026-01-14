import { z } from 'zod'
import { getStoredQuickBooksRefreshToken, storeQuickBooksRefreshToken } from '@/lib/quickbooks/token-store'

type QboEnv = {
  clientId: string
  clientSecret: string
  realmId: string
  refreshToken: string
  refreshTokenSource: 'db' | 'env'
  sandbox: boolean
  minorVersion: string
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  x_refresh_token_expires_in: z.number().optional(),
  token_type: z.string().optional(),
})

function describeFetchFailure(error: unknown): string {
  if (!error) return 'unknown error'
  if (error instanceof Error) {
    const anyErr = error as any
    const cause = anyErr?.cause
    if (cause && typeof cause === 'object') {
      const code = (cause as any).code
      const host = (cause as any).hostname
      const msg = (cause as any).message
      if (code || host || msg) {
        return [
          error.message,
          code ? `code=${code}` : null,
          host ? `host=${host}` : null,
          msg && msg !== error.message ? `cause=${msg}` : null,
        ].filter(Boolean).join(' | ')
      }
    }
    return error.message
  }
  return String(error)
}

async function getQboEnv(): Promise<{ ok: true; env: QboEnv } | { ok: false; missing: string[] }> {
  const clientId = process.env.QBO_CLIENT_ID?.trim()
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim()
  const realmId = process.env.QBO_REALM_ID?.trim()

  const storedRefresh = await getStoredQuickBooksRefreshToken()
  const envRefresh = process.env.QBO_REFRESH_TOKEN?.trim()
  const refreshToken = storedRefresh || envRefresh

  const missing: string[] = []
  if (!clientId) missing.push('QBO_CLIENT_ID')
  if (!clientSecret) missing.push('QBO_CLIENT_SECRET')
  if (!realmId) missing.push('QBO_REALM_ID')
  if (!refreshToken) missing.push('QBO_REFRESH_TOKEN')

  if (missing.length > 0) return { ok: false, missing }

  return {
    ok: true,
    env: {
      clientId: clientId!,
      clientSecret: clientSecret!,
      realmId: realmId!,
      refreshToken: refreshToken!,
      refreshTokenSource: storedRefresh ? 'db' : 'env',
      sandbox: (process.env.QBO_SANDBOX || '').toLowerCase() === 'true',
      minorVersion: (process.env.QBO_MINOR_VERSION || '75').trim() || '75',
    },
  }
}

export type QboAuthResult = {
  accessToken: string
  rotatedRefreshToken: string | null
  refreshTokenPersisted: boolean
  refreshTokenSource: 'db' | 'env'
  realmId: string
  minorVersion: string
  sandbox: boolean
}

export async function getQuickBooksConfig(): Promise<{ configured: true } | { configured: false; missing: string[] }> {
  const env = await getQboEnv()
  if (!env.ok) return { configured: false, missing: env.missing }
  return { configured: true }
}

export async function refreshQuickBooksAccessToken(): Promise<QboAuthResult> {
  const envResult = await getQboEnv()
  if (!envResult.ok) {
    throw new Error(`QuickBooks is not configured. Missing: ${envResult.missing.join(', ')}`)
  }

  const { clientId, clientSecret, realmId, refreshToken, sandbox, minorVersion } = envResult.env

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  let res: Response
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
  } catch (error) {
    throw new Error(`QuickBooks token refresh request failed: ${describeFetchFailure(error)}`)
  }

  const json = await res.json().catch(() => null)

  if (!res.ok) {
    const errorHint = typeof json === 'object' && json ? JSON.stringify(json) : String(json)
    throw new Error(`QuickBooks token refresh failed (${res.status}): ${errorHint}`)
  }

  const parsed = tokenResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error('QuickBooks token refresh failed: invalid response format')
  }

  const rotatedRefreshToken = parsed.data.refresh_token && parsed.data.refresh_token !== refreshToken
    ? parsed.data.refresh_token
    : null

  // Persist refresh token to DB so Intuit token rotation doesn't require .env edits.
  // - If Intuit rotated it, store the rotated token.
  // - Otherwise, store the current token once so future refreshes can use DB.
  const tokenToStore = rotatedRefreshToken || refreshToken
  const refreshTokenPersisted = await storeQuickBooksRefreshToken(tokenToStore)

  return {
    accessToken: parsed.data.access_token,
    rotatedRefreshToken,
    refreshTokenPersisted,
    refreshTokenSource: envResult.env.refreshTokenSource,
    realmId,
    minorVersion,
    sandbox,
  }
}

function qboApiBase(sandbox: boolean): string {
  return sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com'
}

export async function qboQuery<T = unknown>(auth: QboAuthResult, query: string): Promise<T> {
  const url = new URL(`${qboApiBase(auth.sandbox)}/v3/company/${auth.realmId}/query`)
  url.searchParams.set('query', query)
  url.searchParams.set('minorversion', auth.minorVersion)

  let res: Response
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
      },
    })
  } catch (error) {
    throw new Error(`QuickBooks query request failed: ${describeFetchFailure(error)}`)
  }

  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const errorHint = typeof json === 'object' && json ? JSON.stringify(json) : String(json)
    throw new Error(`QuickBooks query failed (${res.status}): ${errorHint}`)
  }

  return json as T
}

export function toQboDateTime(value: Date): string {
  // QBO query expects an RFC3339-like datetime string. Avoid milliseconds.
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
