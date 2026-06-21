import { NextRequest, NextResponse } from 'next/server'
import { getBrandingSettingsSnapshot } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const settings = await getBrandingSettingsSnapshot()

  // Favicon now lives in StoredFile (SETTINGS_BRANDING / COMPANY_FAVICON)
  const faviconConfigured =
    (settings?.companyFaviconMode === 'UPLOAD') ||
    (settings?.companyFaviconMode === 'LINK' && typeof settings.companyFaviconUrl === 'string' && !!settings.companyFaviconUrl.trim())

  const target = faviconConfigured
    ? `/api/branding/favicon?v=${settings?.updatedAt ? new Date(settings.updatedAt).getTime() : 0}`
    : '/icon.svg'

  const host = request.headers.get('host') ?? request.nextUrl.host
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')
  return NextResponse.redirect(new URL(target, `${proto}://${host}`), { status: 307 })
}