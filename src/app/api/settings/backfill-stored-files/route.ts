import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { backfillStoredFiles } from '@/lib/stored-file'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 5,
      message: 'Too many requests. Please slow down.',
    },
    'backfill-stored-files'
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const { inserted } = await backfillStoredFiles()
    return NextResponse.json({ ok: true, inserted })
  } catch (error: any) {
    console.error('[backfill-stored-files]', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to backfill StoredFile registry' },
      { status: 500 }
    )
  }
}
