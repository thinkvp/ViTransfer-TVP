import { prisma } from './db'
import { NextRequest } from 'next/server'
import { getSecuritySettings } from './video-access'
import { sendPushNotification } from './push-notifications'
import { getClientIpAddress } from './utils'

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

  // Avoid inflating metrics with admin activity (admin sessions prefixed with "admin:")
  if (sessionId?.startsWith('admin:')) {
    return
  }

  // Get IP address using the centralised helper (respects TRUSTED_PROXIES, CF headers, etc.)
  const ipAddress = getClientIpAddress(request)
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
