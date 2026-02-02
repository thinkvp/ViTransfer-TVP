import { NextRequest, NextResponse } from 'next/server'
import { requireApiMenu } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getQuickBooksConfig, qboQuery, refreshQuickBooksAccessToken } from '@/lib/quickbooks/qbo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiMenu(request, 'sales')
  if (authResult instanceof Response) return authResult

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 30,
      message: 'Too many requests. Please slow down.'
    },
    'sales-qbo-health',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  const cfg = await getQuickBooksConfig()
  if (!cfg.configured) {
    const res = NextResponse.json({ configured: false, missing: cfg.missing })
    res.headers.set('Cache-Control', 'no-store')
    return res
  }

  try {
    const auth = await refreshQuickBooksAccessToken()
    const info = await qboQuery<any>(auth, 'select * from CompanyInfo')
    const companyName = info?.QueryResponse?.CompanyInfo?.[0]?.CompanyName ?? null

    const res = NextResponse.json({
      configured: true,
      realmId: auth.realmId,
      sandbox: auth.sandbox,
      companyName,
      rotatedRefreshToken: auth.rotatedRefreshToken,
      refreshTokenSource: auth.refreshTokenSource,
      refreshTokenPersisted: auth.refreshTokenPersisted,
    })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (error) {
    console.error('QuickBooks health check failed:', error)
    return NextResponse.json(
      { configured: true, error: error instanceof Error ? error.message : 'QuickBooks request failed' },
      { status: 500 }
    )
  }
}
