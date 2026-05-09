import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireMenuAccess } from '@/lib/rbac-api'
import { getLocalToS3MigrationStatus } from '@/lib/local-to-s3-migration'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const rateLimitResult = await rateLimit(request, { windowMs: 10 * 1000, maxRequests: 30 }, 'migrate-local-to-s3-status')
  if (rateLimitResult) return rateLimitResult

  return NextResponse.json(getLocalToS3MigrationStatus())
}
