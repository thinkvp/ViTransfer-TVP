import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

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
      },
    })

    return NextResponse.json(settings)
  } catch (error) {
    console.error('Error fetching push notification settings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch push notification settings' },
      { status: 500 }
    )
  }
}

export async function PATCH(request: NextRequest) {
  const authResult = await requireApiAdmin(request)
  if (authResult instanceof Response) {
    return authResult
  }

  try {
    const body = await request.json()

    const settings = await prisma.pushNotificationSettings.upsert({
      where: { id: 'default' },
      update: {
        enabled: body.enabled ?? false,
        provider: body.provider || null,
        webhookUrl: body.webhookUrl || null,
        title: body.title || null,
        notifyUnauthorizedOTP: body.notifyUnauthorizedOTP ?? true,
        notifyFailedAdminLogin: body.notifyFailedAdminLogin ?? true,
        notifySuccessfulAdminLogin: body.notifySuccessfulAdminLogin ?? true,
        notifyFailedSharePasswordAttempt: body.notifyFailedSharePasswordAttempt ?? true,
        notifySuccessfulShareAccess: body.notifySuccessfulShareAccess ?? true,
        notifyClientComments: body.notifyClientComments ?? true,
        notifyVideoApproval: body.notifyVideoApproval ?? true,
      },
      create: {
        id: 'default',
        enabled: body.enabled ?? false,
        provider: body.provider || null,
        webhookUrl: body.webhookUrl || null,
        title: body.title || null,
        notifyUnauthorizedOTP: body.notifyUnauthorizedOTP ?? true,
        notifyFailedAdminLogin: body.notifyFailedAdminLogin ?? true,
        notifySuccessfulAdminLogin: body.notifySuccessfulAdminLogin ?? true,
        notifyFailedSharePasswordAttempt: body.notifyFailedSharePasswordAttempt ?? true,
        notifySuccessfulShareAccess: body.notifySuccessfulShareAccess ?? true,
        notifyClientComments: body.notifyClientComments ?? true,
        notifyVideoApproval: body.notifyVideoApproval ?? true,
      },
    })

    return NextResponse.json(settings)
  } catch (error) {
    console.error('Error updating push notification settings:', error)
    return NextResponse.json(
      { error: 'Failed to update push notification settings' },
      { status: 500 }
    )
  }
}
