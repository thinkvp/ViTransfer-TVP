import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile, uploadFile } from '@/lib/storage'
import { getImageDimensions } from '@/lib/image-dimensions'
import type { Prisma } from '@prisma/client'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FAVICON_BYTES = 512 * 1024 // 512KB
const FAVICON_MAX_WIDTH = 512
const FAVICON_MAX_HEIGHT = 512

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
      message: 'Too many favicon upload requests. Please slow down.',
    },
    'settings-company-favicon-upload',
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

    if (file.size > MAX_FAVICON_BYTES) {
      return NextResponse.json(
        { error: `Favicon file is too large. Max size is ${Math.floor(MAX_FAVICON_BYTES / 1024)}KB.` },
        { status: 413 }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    const dims = getImageDimensions(buffer)
    if (!dims || dims.type !== 'png') {
      return NextResponse.json({ error: 'Invalid image. Please upload a PNG image.' }, { status: 400 })
    }

    if (dims.width > FAVICON_MAX_WIDTH || dims.height > FAVICON_MAX_HEIGHT) {
      return NextResponse.json(
        { error: `Invalid favicon resolution. Max allowed: ${FAVICON_MAX_WIDTH}x${FAVICON_MAX_HEIGHT}px.` },
        { status: 400 }
      )
    }

    const storagePath = 'branding/company-favicon.png'

    const existing = (await prisma.settings.findUnique({
      where: { id: 'default' },
      // NOTE: keep types happy if Prisma Client isn't regenerated yet.
      select: { companyFaviconPath: true } as any,
    } as any)) as any

    await uploadFile(storagePath, buffer, buffer.length, 'image/png')

    if (existing?.companyFaviconPath && existing.companyFaviconPath !== storagePath) {
      await deleteFile(existing.companyFaviconPath).catch(() => {})
    }

    const updateData: Prisma.SettingsUpdateInput = {
      companyFaviconMode: 'UPLOAD',
      companyFaviconPath: storagePath,
      companyFaviconUrl: null,
    } as any
    const createData: Prisma.SettingsCreateInput = {
      id: 'default',
      companyFaviconMode: 'UPLOAD',
      companyFaviconPath: storagePath,
      companyFaviconUrl: null,
    } as any

    await prisma.settings.upsert({
      where: { id: 'default' },
      update: updateData,
      create: createData,
    })

    const response = NextResponse.json({ success: true, companyFaviconPath: storagePath })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error uploading company favicon:', error)
    return NextResponse.json({ error: 'Failed to upload favicon' }, { status: 500 })
  }
}
