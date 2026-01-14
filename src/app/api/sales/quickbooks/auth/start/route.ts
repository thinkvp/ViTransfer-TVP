import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireApiAdmin } from '@/lib/auth'
import { requireMenuAccess } from '@/lib/rbac-api'
import { getRedis } from '@/lib/redis'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function computeRedirectUri(request: NextRequest): string {
  const override = process.env.QBO_REDIRECT_URI?.trim()
  if (override) return override

  const url = new URL(request.url)
  return `${url.origin}/api/sales/quickbooks/auth/callback`
}

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'sales')
  if (forbiddenMenu) return forbiddenMenu

  const clientId = process.env.QBO_CLIENT_ID?.trim()
  if (!clientId) {
    return NextResponse.json({ error: 'QuickBooks not configured (missing QBO_CLIENT_ID)' }, { status: 400 })
  }

  const redirectUri = computeRedirectUri(request)

  const state = crypto.randomBytes(16).toString('hex')
  const scopes = ['com.intuit.quickbooks.accounting'].join(' ')

  // Store OAuth state server-side (cookie-free) for callback validation.
  const redis = getRedis()
  if (redis.status !== 'ready') {
    await redis.connect()
  }
  await redis.setex(`qbo:oauth_state:${state}`, 10 * 60, '1')

  const authorizeUrl = new URL('https://appcenter.intuit.com/connect/oauth2')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', scopes)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', state)

  const asJson = request.nextUrl.searchParams.get('json') === '1'

  if (asJson) {
    const res = NextResponse.json(
      {
        authorizeUrl: authorizeUrl.toString(),
        redirectUri,
      },
      { status: 200 }
    )
    return res
  }

  return NextResponse.redirect(authorizeUrl.toString())
}
