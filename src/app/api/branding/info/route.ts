import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

/**
 * Public endpoint — returns minimal branding info (logo availability + company domain link).
 * No authentication required. Used by login page, share auth screens, etc.
 */
export async function GET(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down.',
  }, 'branding-info')
  if (rateLimitResult) return rateLimitResult

  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
      select: {
        companyLogoMode: true,
        companyLogoPath: true,
        companyLogoUrl: true,
        mainCompanyDomain: true,
        companyName: true,
        accentColor: true,
      },
    })

    const hasLogo =
      settings?.companyLogoMode === 'UPLOAD'
        ? Boolean(settings.companyLogoPath)
        : settings?.companyLogoMode === 'LINK'
          ? Boolean(settings.companyLogoUrl)
          : false


    const response = NextResponse.json({
      hasLogo,
      mainCompanyDomain: settings?.mainCompanyDomain || null,
      companyName: settings?.companyName || null,
      accentColor: settings?.accentColor || null,
    })
    response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120')
    return response
  } catch {
    return NextResponse.json({ hasLogo: false, mainCompanyDomain: null, companyName: null, accentColor: null })
  }
}
