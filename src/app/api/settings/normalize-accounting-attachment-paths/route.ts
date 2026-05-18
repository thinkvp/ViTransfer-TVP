import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { normalizeAccountingAttachmentStoragePaths } from '@/lib/accounting/file-storage'

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
    'normalize-accounting-attachment-paths',
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
    const result = await normalizeAccountingAttachmentStoragePaths(dryRun)
    return NextResponse.json(result)
  } catch (error: any) {
    console.error('[normalize-accounting-attachment-paths]', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to normalize accounting attachment paths' },
      { status: 500 },
    )
  }
}