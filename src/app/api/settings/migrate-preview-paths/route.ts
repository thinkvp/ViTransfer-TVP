import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { migratePreviewPaths } from '@/lib/preview-path-migration'

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
    { windowMs: 60 * 1000, maxRequests: 10, message: 'Too many requests. Please slow down.' },
    'migrate-preview-paths'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
  } catch {
    // Default to dry run when the body is missing or malformed.
  }

  try {
    const result = await migratePreviewPaths(dryRun)
    return NextResponse.json(result)
  } catch (error: any) {
    console.error('[migrate-preview-paths]', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to migrate preview paths' },
      { status: 500 }
    )
  }
}