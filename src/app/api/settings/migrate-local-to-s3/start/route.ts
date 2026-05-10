import { NextRequest, NextResponse } from 'next/server'
import { requireApiAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { startLocalToS3Migration } from '@/lib/local-to-s3-migration'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeProjectSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(request, { windowMs: 60 * 1000, maxRequests: 5 }, 'migrate-local-to-s3-start')
  if (rateLimitResult) return rateLimitResult

  try {
    const body = await request.json().catch(() => ({}))
    const result = await startLocalToS3Migration({
      config: {
        endpoint: body?.endpoint,
        bucket: body?.bucket,
        region: body?.region,
        accessKeyId: body?.accessKeyId,
        secretAccessKey: body?.secretAccessKey,
        forcePathStyle: body?.forcePathStyle,
      },
      overwriteExisting: body?.overwriteExisting === true,
      concurrency: Number(body?.concurrency || 3),
      multipartThresholdMB: Number(body?.multipartThresholdMB || 64),
      multipartPartSizeMB: Number(body?.multipartPartSizeMB || 64),
      multipartQueueSize: Number(body?.multipartQueueSize || 4),
    })

    return NextResponse.json(result)
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Failed to start migration' }, { status: 400 })
  }
}
