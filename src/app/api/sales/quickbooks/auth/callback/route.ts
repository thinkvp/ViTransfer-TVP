import { NextRequest, NextResponse } from 'next/server'
import jwt from 'jsonwebtoken'
import { storeQuickBooksRefreshToken } from '@/lib/quickbooks/token-store'
import { getRedis } from '@/lib/redis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type QboOauthStatePayload = {
  type: 'qbo_oauth_state'
  userId: string
  nonce: string
}

function getQboOauthStateSecret(): string {
  const secret = process.env.JWT_SECRET?.trim()
  if (secret) return secret
  throw new Error('Missing JWT_SECRET (required to verify QBO OAuth state)')
}

function computeRedirectUri(request: NextRequest): string {
  const override = process.env.QBO_REDIRECT_URI?.trim()
  if (override) return override

  const url = new URL(request.url)
  return `${url.origin}/api/sales/quickbooks/auth/callback`
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const realmId = url.searchParams.get('realmId')
  const state = url.searchParams.get('state')

  const doneUrl = new URL('/admin/sales/settings', url.origin)

  if (!state) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'missing_state')
    return NextResponse.redirect(doneUrl.toString())
  }

  let parsed: QboOauthStatePayload | null = null
  try {
    parsed = jwt.verify(state, getQboOauthStateSecret(), { algorithms: ['HS256'] }) as QboOauthStatePayload
  } catch {
    parsed = null
  }

  if (!parsed || parsed.type !== 'qbo_oauth_state' || !parsed.userId || !parsed.nonce) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'invalid_state')
    return NextResponse.redirect(doneUrl.toString())
  }

  const redis = getRedis()
  if (redis.status !== 'ready') {
    await redis.connect()
  }
  const stateKey = `qbo:oauth_state:${parsed.nonce}`
  const storedUserId = await redis.get(stateKey)
  if (!storedUserId || storedUserId !== parsed.userId) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'invalid_state')
    return NextResponse.redirect(doneUrl.toString())
  }
  await redis.del(stateKey)

  if (!code) {
    const err = url.searchParams.get('error') || 'authorization_failed'
    const desc = url.searchParams.get('error_description')
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', String(err))
    if (desc) doneUrl.searchParams.set('description', String(desc).slice(0, 500))
    return NextResponse.redirect(doneUrl.toString())
  }

  const clientId = process.env.QBO_CLIENT_ID?.trim()
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'missing_client_credentials')
    return NextResponse.redirect(doneUrl.toString())
  }

  const redirectUri = computeRedirectUri(request)

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  const json = await tokenRes.json().catch(() => null)
  if (!tokenRes.ok) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'token_exchange_failed')
    doneUrl.searchParams.set('status', String(tokenRes.status))
    return NextResponse.redirect(doneUrl.toString())
  }

  const refreshToken = typeof json?.refresh_token === 'string' ? json.refresh_token.trim() : ''
  if (!refreshToken) {
    doneUrl.searchParams.set('qbo', 'error')
    doneUrl.searchParams.set('reason', 'missing_refresh_token')
    return NextResponse.redirect(doneUrl.toString())
  }

  const persisted = await storeQuickBooksRefreshToken(refreshToken)

  doneUrl.searchParams.set('qbo', 'authorized')
  if (realmId) doneUrl.searchParams.set('realmId', realmId)

  const res = NextResponse.redirect(doneUrl.toString())
  // Include a header hint for debugging if needed
  res.headers.set('X-QBO-RefreshToken-Persisted', persisted ? 'true' : 'false')
  return res
}
