import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { cleanupProjectStorageOrphans } from '@/lib/project-storage-orphan-cleanup'

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
      maxRequests: 10,
      message: 'Too many requests. Please slow down.',
    },
    'cleanup-orphan-project-files'
  )
  if (rateLimitResult) return rateLimitResult

  let dryRun = true
  try {
    const body = await request.json().catch(() => ({}))
    dryRun = body?.dryRun !== false
  } catch {
    // Ignore malformed bodies; default to dry run.
  }

  try {
    const result = await cleanupProjectStorageOrphans(dryRun)
    return NextResponse.json(result)
  } catch (error: any) {
    console.error('[cleanup-orphan-project-files]', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to scan project storage for orphan files' },
      { status: 500 }
    )
  }
}