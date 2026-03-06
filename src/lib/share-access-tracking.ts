import { prisma } from './db'
import { NextRequest } from 'next/server'
import { getSecuritySettings } from './video-access'
import { sendPushNotification } from './push-notifications'
import { getClientIpAddress } from './utils'
import { isLikelyAdminIp } from './admin-ip-match'
import { recordClientActivity } from './client-activity'

export async function trackSharePageAccess(params: {
  projectId: string
  accessMethod: 'OTP' | 'PASSWORD' | 'GUEST' | 'NONE'
  eventType?: 'ACCESS' | 'SWITCH_AWAY'
  email?: string
  originProjectTitle?: string
  targetProjectTitle?: string
  sessionId: string
  request: NextRequest
}) {
  const {
    projectId,
    accessMethod,
    eventType = 'ACCESS',
    email,
    originProjectTitle,
    targetProjectTitle,
    sessionId,
    request,
  } = params

  const settings = await getSecuritySettings()

  // Avoid inflating metrics with admin activity (admin sessions prefixed with "admin:")
  if (sessionId?.startsWith('admin:')) {
    return
  }

  // Get IP address using the centralised helper (respects TRUSTED_PROXIES, CF headers, etc.)
  const ipAddress = getClientIpAddress(request)
  const userAgent = request.headers.get('user-agent') || undefined

  // Best-effort: skip tracking when the visitor's IP matches a known internal user.
  // This catches admins accessing the share page without an admin JWT in the request
  // (e.g. opening it in a separate tab or clicking "Continue as Guest").
  const likelyAdmin = await isLikelyAdminIp(ipAddress).catch(() => false)

  if (likelyAdmin) {
    return
  }

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true },
    })

    await recordClientActivity({
      sessionId,
      projectId,
      projectTitle: project?.title || null,
      activityType: 'VIEWING_SHARE_PAGE',
      accessMethod,
      email: accessMethod === 'OTP' ? email || null : null,
      ipAddress: ipAddress || null,
    })

    if (!settings.trackAnalytics) {
      return
    }

    await prisma.sharePageAccess.create({
      data: {
        projectId,
        accessMethod,
        eventType,
        email,
        originProjectTitle,
        targetProjectTitle,
        sessionId,
        ipAddress,
        userAgent,
      },
    })

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
      title: eventType === 'SWITCH_AWAY' ? 'Client Switched Project' : 'Share Page Accessed',
      message: eventType === 'SWITCH_AWAY' ? 'A client switched to another project' : 'A client accessed the share page',
      details: {
        'Project': project?.title || 'Unknown Project',
        'Access Method': accessMethodDescription,
        ...(originProjectTitle ? { 'Origin Project': originProjectTitle } : {}),
        ...(targetProjectTitle ? { 'Target Project': targetProjectTitle } : {}),
        'IP Address': ipAddress,
      },
    })
  } catch (error) {
    console.error('[ANALYTICS] Failed to track share page access:', error)
    // Don't throw - analytics failures shouldn't break authentication
  }
}
