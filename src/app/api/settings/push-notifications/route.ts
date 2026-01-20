import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { Prisma } from '@prisma/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  try {
    const settings = await prisma.pushNotificationSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: {
        id: 'default',
        enabled: false,
        provider: null,
        webhookUrl: null,
        title: null,
        notifyUnauthorizedOTP: true,
        notifyFailedAdminLogin: true,
        notifySuccessfulAdminLogin: true,
        notifyFailedSharePasswordAttempt: true,
        notifySuccessfulShareAccess: true,
        notifyClientComments: true,
        notifyVideoApproval: true,
        notifySalesQuoteViewed: true,
        notifySalesQuoteAccepted: true,
        notifySalesInvoiceViewed: true,
        notifySalesInvoicePaid: true,
        notifyPasswordResetRequested: true,
        notifyPasswordResetSuccess: true,
      },
    })

    const response = NextResponse.json(settings)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error fetching push notification settings:', error)

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2021' || error.code === 'P2022') {
        return NextResponse.json(
          {
            error:
              'Push notification settings table/columns are missing. Your database is likely out of date. Run Prisma migrations (npx prisma migrate deploy) and restart the app.',
            code: error.code,
          },
          { status: 500 }
        )
      }

      return NextResponse.json(
        {
          error: 'Failed to fetch push notification settings',
          code: error.code,
          ...(process.env.NODE_ENV !== 'production'
            ? { details: error.message, meta: (error as any).meta }
            : {}),
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        error: 'Failed to fetch push notification settings',
        ...(process.env.NODE_ENV !== 'production' && error instanceof Error
          ? { details: error.message }
          : {}),
      },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'settings')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'changeSettings')
  if (forbiddenAction) return forbiddenAction

  try {
    const body = await request.json()

    const provider = typeof body?.provider === 'string' && body.provider.trim() ? body.provider.trim() : null
    const webhookUrl = typeof body?.webhookUrl === 'string' && body.webhookUrl.trim() ? body.webhookUrl.trim() : null
    const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : null

    const settings = await prisma.pushNotificationSettings.upsert({
      where: { id: 'default' },
      update: {
        enabled: body.enabled ?? false,
        provider,
        webhookUrl,
        title,
        notifyUnauthorizedOTP: body.notifyUnauthorizedOTP ?? true,
        notifyFailedAdminLogin: body.notifyFailedAdminLogin ?? true,
        notifySuccessfulAdminLogin: body.notifySuccessfulAdminLogin ?? true,
        notifyFailedSharePasswordAttempt: body.notifyFailedSharePasswordAttempt ?? true,
        notifySuccessfulShareAccess: body.notifySuccessfulShareAccess ?? true,
        notifyClientComments: body.notifyClientComments ?? true,
        notifyVideoApproval: body.notifyVideoApproval ?? true,
        notifySalesQuoteViewed: body.notifySalesQuoteViewed ?? true,
        notifySalesQuoteAccepted: body.notifySalesQuoteAccepted ?? true,
        notifySalesInvoiceViewed: body.notifySalesInvoiceViewed ?? true,
        notifySalesInvoicePaid: body.notifySalesInvoicePaid ?? true,
        notifyPasswordResetRequested: body.notifyPasswordResetRequested ?? true,
        notifyPasswordResetSuccess: body.notifyPasswordResetSuccess ?? true,
      },
      create: {
        id: 'default',
        enabled: body.enabled ?? false,
        provider,
        webhookUrl,
        title,
        notifyUnauthorizedOTP: body.notifyUnauthorizedOTP ?? true,
        notifyFailedAdminLogin: body.notifyFailedAdminLogin ?? true,
        notifySuccessfulAdminLogin: body.notifySuccessfulAdminLogin ?? true,
        notifyFailedSharePasswordAttempt: body.notifyFailedSharePasswordAttempt ?? true,
        notifySuccessfulShareAccess: body.notifySuccessfulShareAccess ?? true,
        notifyClientComments: body.notifyClientComments ?? true,
        notifyVideoApproval: body.notifyVideoApproval ?? true,
        notifySalesQuoteViewed: body.notifySalesQuoteViewed ?? true,
        notifySalesQuoteAccepted: body.notifySalesQuoteAccepted ?? true,
        notifySalesInvoiceViewed: body.notifySalesInvoiceViewed ?? true,
        notifySalesInvoicePaid: body.notifySalesInvoicePaid ?? true,
        notifyPasswordResetRequested: body.notifyPasswordResetRequested ?? true,
        notifyPasswordResetSuccess: body.notifyPasswordResetSuccess ?? true,
      },
    })

    const response = NextResponse.json(settings)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error updating push notification settings:', error)

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      // Common when the database hasn't been migrated after upgrading.
      if (error.code === 'P2021' || error.code === 'P2022') {
        return NextResponse.json(
          {
            error: 'Push notification settings table/columns are missing. Your database is likely out of date. Run Prisma migrations (npx prisma migrate deploy) and restart the app.',
            code: error.code,
          },
          { status: 500 }
        )
      }

      return NextResponse.json(
        {
          error: 'Failed to update push notification settings',
          code: error.code,
          ...(process.env.NODE_ENV !== 'production'
            ? { details: error.message, meta: (error as any).meta }
            : {}),
        },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        error: 'Failed to update push notification settings',
        ...(process.env.NODE_ENV !== 'production' && error instanceof Error
          ? { details: error.message }
          : {}),
      },
      { status: 500 }
    )
  }
}
