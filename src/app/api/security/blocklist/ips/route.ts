import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/auth'
import { invalidateBlocklistCache } from '@/lib/video-access'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
export const runtime = 'nodejs'

export const dynamic = 'force-dynamic'

/**
 * GET /api/security/blocklist/ips
 *
 * Get all blocked IP addresses
 * ADMIN ONLY
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'security')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'viewSecurityBlocklists')
  if (forbiddenAction) return forbiddenAction

  try {
    const blockedIPs = await prisma.blockedIP.findMany({
      orderBy: { createdAt: 'desc' }
    })

    const response = NextResponse.json({
      blockedIPs,
      count: blockedIPs.length,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error fetching blocked IPs:', error)
    return NextResponse.json(
      { error: 'Failed to fetch blocked IPs' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/security/blocklist/ips
 *
 * Add IP address to blocklist
 * ADMIN ONLY
 */
export async function POST(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'security')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageSecurityBlocklists')
  if (forbiddenAction) return forbiddenAction

  try {
    const body = await request.json()
    const { ipAddress, reason } = body

    if (!ipAddress || typeof ipAddress !== 'string') {
      return NextResponse.json(
        { error: 'IP address is required' },
        { status: 400 }
      )
    }

    // Basic IP validation
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/
    if (!ipPattern.test(ipAddress)) {
      return NextResponse.json(
        { error: 'Invalid IP address format' },
        { status: 400 }
      )
    }

    // Check if already blocked
    const existing = await prisma.blockedIP.findUnique({
      where: { ipAddress }
    })

    if (existing) {
      return NextResponse.json(
        { error: 'IP address already blocked' },
        { status: 409 }
      )
    }

    const blockedIP = await prisma.blockedIP.create({
      data: {
        ipAddress,
        reason: reason || null,
        createdBy: authResult.id,
      }
    })

    // Invalidate cache
    await invalidateBlocklistCache()

    const response = NextResponse.json({
      success: true,
      blockedIP,
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error blocking IP:', error)
    return NextResponse.json(
      { error: 'Failed to block IP address' },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/security/blocklist/ips
 *
 * Remove IP address from blocklist
 * ADMIN ONLY
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireApiUser(request)
  if (authResult instanceof Response) {
    return authResult
  }

  const forbiddenMenu = requireMenuAccess(authResult, 'security')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageSecurityBlocklists')
  if (forbiddenAction) return forbiddenAction

  try {
    const body = await request.json()
    const { id } = body

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'ID is required' },
        { status: 400 }
      )
    }

    await prisma.blockedIP.delete({
      where: { id }
    })

    // Invalidate cache
    await invalidateBlocklistCache()

    const response = NextResponse.json({
      success: true,
      message: 'IP address unblocked successfully',
    })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error unblocking IP:', error)
    return NextResponse.json(
      { error: 'Failed to unblock IP address' },
      { status: 500 }
    )
  }
}
