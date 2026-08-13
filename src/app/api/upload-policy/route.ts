import { NextRequest, NextResponse } from 'next/server'
import { getClientUploadPolicy } from '@/lib/settings'
import { getAllowedFileTypesDescription } from '@/lib/fileUpload'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The system-wide client upload type policy, so the share page can pre-check a selection and
 * show an accurate "Supported file types" list instead of a hardcoded one. Unauthenticated by
 * design — it carries no project or client data, only which file types the server will accept,
 * which is already discoverable by attempting an upload. The routes that accept uploads
 * re-check the policy themselves; this is a UX helper, never the enforcement point.
 */
export async function GET(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.',
  }, 'upload-policy')
  if (rateLimitResult) return rateLimitResult

  const policy = await getClientUploadPolicy()

  return NextResponse.json({
    categories: policy.categories,
    customExtensions: policy.customExtensions,
    description: getAllowedFileTypesDescription(policy),
  })
}
