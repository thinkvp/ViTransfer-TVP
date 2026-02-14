import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile, uploadFile } from '@/lib/storage'
import { invalidateEmailSettingsCache } from '@/lib/email'
import { getImageDimensions } from '@/lib/image-dimensions'
import type { Prisma } from '@prisma/client'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LOGO_BYTES = 2 * 1024 * 1024 // 2MB
const DARK_LOGO_MAX_WIDTH = 800
const DARK_LOGO_MAX_HEIGHT = 800

export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeSettings')
  if (forbiddenAction) return forbiddenAction

  const rateLimitResult = await rateLimit(
    request,
    {
      windowMs: 60 * 1000,
      maxRequests: 10,
      message: 'Too many logo upload requests. Please slow down.',
    },
    'settings-dark-logo-upload',
    authResult.id
  )
  if (rateLimitResult) return rateLimitResult

  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: 'Empty file provided' }, { status: 400 })
    }

    if (file.size > MAX_LOGO_BYTES) {
      return NextResponse.json(
        { error: `Logo file is too large. Max size is ${Math.floor(MAX_LOGO_BYTES / 1024 / 1024)}MB.` },
        { status: 413 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    const dims = getImageDimensions(buffer)
    if (!dims) {
      return NextResponse.json(
        { error: 'Invalid image. Please upload a PNG or JPG image.' },
        { status: 400 }
      )
    }

    if (dims.width > DARK_LOGO_MAX_WIDTH || dims.height > DARK_LOGO_MAX_HEIGHT) {
      return NextResponse.json(
        { error: `Invalid logo resolution. Max allowed: ${DARK_LOGO_MAX_WIDTH}x${DARK_LOGO_MAX_HEIGHT}px.` },
        { status: 400 }
      )
    }

    const ext = dims.type === 'png' ? 'png' : 'jpg'
    const contentType = dims.type === 'png' ? 'image/png' : 'image/jpeg'
    const storagePath = `branding/company-logo-dark.${ext}`

    const existing = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: { darkLogoPath: true },
    })

    await uploadFile(storagePath, buffer, buffer.length, contentType)

    if (existing?.darkLogoPath && existing.darkLogoPath !== storagePath) {
      await deleteFile(existing.darkLogoPath).catch(() => {})
    }

    const updateData: Prisma.SettingsUpdateInput = {
      darkLogoMode: 'UPLOAD',
      darkLogoPath: storagePath,
      darkLogoUrl: null,
    }
    const createData: Prisma.SettingsCreateInput = {
      id: 'default',
      darkLogoMode: 'UPLOAD',
      darkLogoPath: storagePath,
      darkLogoUrl: null,
    }

    await prisma.settings.upsert({
      where: { id: 'default' },
      update: updateData,
      create: createData,
    })

    invalidateEmailSettingsCache()

    const response = NextResponse.json({ success: true, darkLogoPath: storagePath })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error uploading dark logo:', error)
    return NextResponse.json({ error: 'Failed to upload dark logo' }, { status: 500 })
  }
}
