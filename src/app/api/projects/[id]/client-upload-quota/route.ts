import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/project-access'
import { rateLimit } from '@/lib/rate-limit'
import { getProjectUploadUsageBytes, toSafeNumber } from '@/lib/project-upload-quota'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params

    // Rate limiting: 60 requests per minute per IP
    const rateLimitResult = await rateLimit(request, {
      windowMs: 60 * 1000,
      maxRequests: 60,
      message: 'Too many requests. Please slow down.'
    }, 'client-upload-quota')

    if (rateLimitResult) return rateLimitResult

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        sharePassword: true,
        authMode: true,
        maxClientUploadAllocationMB: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Authenticate (admin JWT or share bearer token, depending on caller)
    const authResult = await verifyProjectAccess(request, projectId, project.sharePassword, project.authMode)
    if (!authResult.authorized) {
      return authResult.errorResponse!
    }

    const usage = await getProjectUploadUsageBytes(projectId)
    const usedBytes = toSafeNumber(usage.totalBytes)

    return NextResponse.json({
      usedBytes,
      limitMB: project.maxClientUploadAllocationMB,
      breakdown: {
        commentAttachmentsBytes: toSafeNumber(usage.commentBytes),
        uploadsRootBytes: toSafeNumber(usage.uploadsBytes),
      },
    })
  } catch (error) {
    console.error('Error fetching client upload quota:', error)
    return NextResponse.json({ error: 'Unable to process request' }, { status: 500 })
  }
}
