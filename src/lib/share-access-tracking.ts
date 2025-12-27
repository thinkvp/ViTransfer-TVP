import { prisma } from './db'
import { NextRequest } from 'next/server'
import { getSecuritySettings } from './video-access'
import { sendPushNotification } from './push-notifications'

export async function trackSharePageAccess(params: {
  projectId: string
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE'
  email?: string
  sessionId: string
  request: NextRequest
}) {
  const { projectId, accessMethod, email, sessionId, request } = params

  // Check if analytics tracking is enabled
  const settings = await getSecuritySettings()
  if (!settings.trackAnalytics) {
    return
  }

  // Get IP address from headers
  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'unknown'
  const userAgent = request.headers.get('user-agent') || undefined

  try {
    // Get project name for notification
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true },
    })

    await prisma.sharePageAccess.create({
      data: {
        projectId,
        accessMethod,
        email,
        sessionId,
        ipAddress,
        userAgent,
      },
    })

    // Send push notification for successful share page access
    let accessMethodDescription = ''
    if (accessMethod === 'OTP' && email) {
      accessMethodDescription = `OTP (${email})`
    } else if (accessMethod === 'PASSWORD') {
      accessMethodDescription = 'Password'
    } else if (accessMethod === 'GUEST') {
      accessMethodDescription = 'Guest Access'
    } else if (accessMethod === 'NONE') {
      accessMethodDescription = 'No Authentication (Open Access)'
    } else {
      accessMethodDescription = accessMethod
    }

    await sendPushNotification({
      type: 'SHARE_ACCESS',
      projectId,
      projectName: project?.title || 'Unknown Project',
      title: 'Share Page Accessed',
      message: `A client accessed the share page`,
      details: {
        'Project': project?.title || 'Unknown Project',
        'Access Method': accessMethodDescription,
        'IP Address': ipAddress,
      },
    })
  } catch (error) {
    console.error('[ANALYTICS] Failed to track share page access:', error)
    // Don't throw - analytics failures shouldn't break authentication
  }
}
