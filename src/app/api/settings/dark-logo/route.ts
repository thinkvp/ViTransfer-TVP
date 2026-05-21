import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { deleteFile, uploadFile } from '@/lib/storage'
import { invalidateEmailSettingsCache } from '@/lib/email'
import { invalidateSettingsCaches } from '@/lib/settings'
import { getImageDimensions } from '@/lib/image-dimensions'
import type { Prisma } from '@prisma/client'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'




















// Dark logo upload endpoint removed: always use main logo
export async function POST() {
  return NextResponse.json({ error: 'Dark logo upload is no longer supported.' }, { status: 404 })
}
