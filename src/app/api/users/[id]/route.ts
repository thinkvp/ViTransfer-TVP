import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth, getCurrentUserFromRequest } from '@/lib/auth'
import { hashPassword, validatePassword, verifyPassword } from '@/lib/encryption'
import { revokeAllUserTokens } from '@/lib/token-revocation'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeHexDisplayColor } from '@/lib/display-color'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { logSecurityEvent } from '@/lib/video-access'
import { getClientIpAddress } from '@/lib/utils'
export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

type UserPatchBody = {
  email?: string
  username?: string | null
  name?: string | null
  notes?: string | null
  displayColor?: string | null
  password?: string
  oldPassword?: string
  appRoleId?: string
  active?: boolean
}

// GET /api/users/[id] - Get user by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  // Rate limiting: 60 requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 60,
    message: 'Too many requests. Please slow down.'
  }, 'user-read')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const { id } = await params
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        notes: true,
        displayColor: true,
        active: true,
        role: true,
        appRoleId: true,
        appRole: {
          select: {
            id: true,
            name: true,
            isSystemAdmin: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        // Exclude password from response
      },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const response = NextResponse.json({ user })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    console.error('Error fetching user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}

// PATCH /api/users/[id] - Update user
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  try {
    const { id } = await params
    const body = (await request.json()) as UserPatchBody
    const { email, username, name, notes, displayColor, password, oldPassword, appRoleId, active } = body

    const targetUser = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        active: true,
        appRoleId: true,
        appRole: { select: { isSystemAdmin: true } },
      },
    })

    if (!targetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Build update data
    const updateData: any = {}

    // Track if security-sensitive fields changed
    let roleChanged = false
    let activeChanged = false
    let nextRoleIsSystemAdmin = targetUser.appRole?.isSystemAdmin === true
    
    if (email !== undefined) {
      // Check if email is already taken by another user
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          NOT: { id },
        },
      })

      if (existingUser) {
        return NextResponse.json(
          { error: 'Email already taken' },
          { status: 409 }
        )
      }

      updateData.email = email
    }

    if (username !== undefined) {
      const trimmedUsername = typeof username === 'string' ? username.trim() : ''
      if (trimmedUsername) {
        // Check if username is already taken by another user
        const existingUsername = await prisma.user.findFirst({
          where: {
            username: { equals: trimmedUsername, mode: 'insensitive' },
            NOT: { id },
          },
        })

        if (existingUsername) {
          return NextResponse.json(
            { error: 'Username already taken' },
            { status: 409 }
          )
        }

        updateData.username = trimmedUsername
      } else {
        // Clearing the username
        updateData.username = null
      }
    }

    if (name !== undefined) {
      updateData.name = name
    }

    if (notes !== undefined) {
      updateData.notes = typeof notes === 'string' && notes.trim() ? notes.trim() : null
    }

    if (displayColor !== undefined) {
      // Allow null/empty to clear, or a valid #RRGGBB
      if (displayColor === null || displayColor === '') {
        updateData.displayColor = null
      } else {
        const normalized = normalizeHexDisplayColor(displayColor)
        if (!normalized) {
          return NextResponse.json(
            { error: 'Invalid display colour. Use a hex value like #RRGGBB.' },
            { status: 400 }
          )
        }
        updateData.displayColor = normalized
      }
    }

    if (appRoleId !== undefined) {
      const nextRoleId = typeof appRoleId === 'string' ? appRoleId.trim() : ''
      if (!nextRoleId) {
        return NextResponse.json(
          { error: 'Role is required' },
          { status: 400 }
        )
      }

      const nextRole = await prisma.role.findUnique({
        where: { id: nextRoleId },
        select: { id: true, isSystemAdmin: true },
      })
      if (!nextRole) {
        return NextResponse.json(
          { error: 'Invalid role' },
          { status: 400 }
        )
      }

      nextRoleIsSystemAdmin = nextRole.isSystemAdmin === true

      if (targetUser.appRoleId !== nextRole.id) {
        // Safeguard: prevent demoting the last system-admin user.
        if (targetUser.appRole?.isSystemAdmin && !nextRole.isSystemAdmin) {
          const systemAdminCount = await prisma.user.count({
            where: { appRole: { isSystemAdmin: true } },
          })
          if (systemAdminCount <= 1) {
            return NextResponse.json(
              { error: 'Cannot remove the last Admin user' },
              { status: 400 }
            )
          }
        }

        updateData.appRoleId = nextRole.id
        roleChanged = true
      }
    }

    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return NextResponse.json(
          { error: 'Active must be a boolean' },
          { status: 400 }
        )
      }

      if (nextRoleIsSystemAdmin && active === false) {
        return NextResponse.json(
          { error: 'Admin accounts cannot be disabled' },
          { status: 400 }
        )
      }

      updateData.active = nextRoleIsSystemAdmin ? true : active
      activeChanged = targetUser.active !== updateData.active
    } else if (nextRoleIsSystemAdmin && targetUser.active !== true) {
      updateData.active = true
      activeChanged = true
    }

    // Track if password is being changed (for session regeneration)
    let passwordChanged = false

    // Only update password if provided
    if (password && password.trim() !== '') {
      const isChangingOwnPassword = authResult.id === id
      const isSystemAdmin = authResult.appRoleIsSystemAdmin === true

      // Only System Admins may change another user's password.
      if (!isChangingOwnPassword && !isSystemAdmin) {
        return NextResponse.json(
          { error: 'Forbidden' },
          { status: 403 }
        )
      }

      // SECURITY: Users changing their own password must verify current password.
      if (isChangingOwnPassword) {
        if (!oldPassword || oldPassword.trim() === '') {
          return NextResponse.json(
            { error: 'Current password is required to change password' },
            { status: 400 }
          )
        }

        // Get user's current password hash
        const userWithPassword = await prisma.user.findUnique({
          where: { id },
          select: { password: true },
        })

        if (!userWithPassword) {
          return NextResponse.json(
            { error: 'User not found' },
            { status: 404 }
          )
        }

        // Verify old password
        const isOldPasswordValid = await verifyPassword(oldPassword, userWithPassword.password)
        if (!isOldPasswordValid) {
          return NextResponse.json(
            { error: 'Current password is incorrect' },
            { status: 401 }
          )
        }
      }

      // Validate new password
      const passwordValidation = validatePassword(password)
      if (!passwordValidation.isValid) {
        return NextResponse.json(
          { error: 'Password does not meet requirements', details: passwordValidation.errors },
          { status: 400 }
        )
      }

      updateData.password = await hashPassword(password)
      passwordChanged = true
    }

    // Update user
    const user = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        notes: true,
        displayColor: true,
        active: true,
        role: true,
        appRoleId: true,
        appRole: {
          select: {
            id: true,
            name: true,
            isSystemAdmin: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    })

    // SECURITY: Handle session security for sensitive changes
    const currentUser = await getCurrentUserFromRequest(request)
    let securityMessage = ''

    if (passwordChanged) {
      if (currentUser && currentUser.id === id) {
        // User is changing their own password - revoke all sessions to force fresh login
        await revokeAllUserTokens(user.id)
      } else {
        // Admin is changing another user's password - revoke their sessions
        await revokeAllUserTokens(user.id)
      }

      securityMessage = 'All sessions have been invalidated - user will need to log in again.'
    }

    if (roleChanged) {
      if (currentUser && currentUser.id === id) {
        // User's own role is changing - revoke sessions to refresh permissions on next login
        await revokeAllUserTokens(user.id)
        securityMessage = securityMessage
          ? `${securityMessage} Role updated - please log in again to refresh permissions.`
          : 'Role updated - please log in again to refresh permissions.'
      } else {
        // Another admin is changing this user's role - revoke all their sessions
        await revokeAllUserTokens(user.id)
        securityMessage = securityMessage
          ? `${securityMessage} Role changed - user will need to log in again.`
          : 'Role changed - user will need to log in again to reflect new permissions.'
      }
    }

    if (activeChanged) {
      if (user.active === false) {
        await revokeAllUserTokens(user.id)
        securityMessage = securityMessage
          ? `${securityMessage} Account disabled - user has been signed out.`
          : 'Account disabled - user has been signed out.'
      } else {
        securityMessage = securityMessage
          ? `${securityMessage} Account re-enabled.`
          : 'Account re-enabled.'
      }
    }

    // Log security-sensitive changes
    const ipAddress = getClientIpAddress(request)
    const actorDetails = { actorId: currentUser?.id || authResult.id, actorEmail: currentUser?.email || authResult.email }

    if (passwordChanged) {
      logSecurityEvent({
        type: 'ADMIN_PASSWORD_CHANGED',
        severity: 'INFO',
        ipAddress,
        details: {
          ...actorDetails,
          targetUserId: user.id,
          targetEmail: user.email,
          selfChange: currentUser?.id === id,
        },
      }).catch(() => {})
    }

    if (roleChanged) {
      logSecurityEvent({
        type: 'ADMIN_ROLE_CHANGED',
        severity: 'WARNING',
        ipAddress,
        details: {
          ...actorDetails,
          targetUserId: user.id,
          targetEmail: user.email,
          previousRoleId: targetUser.appRoleId,
          newRoleId: user.appRoleId,
          newRoleName: user.appRole?.name,
        },
      }).catch(() => {})
    }

    if (activeChanged) {
      logSecurityEvent({
        type: user.active ? 'ADMIN_USER_REACTIVATED' : 'ADMIN_USER_DEACTIVATED',
        severity: user.active ? 'INFO' : 'WARNING',
        ipAddress,
        details: {
          ...actorDetails,
          targetUserId: user.id,
          targetEmail: user.email,
        },
      }).catch(() => {})
    }

    return NextResponse.json({
      user,
      message: securityMessage || 'User updated successfully'
    })
  } catch (error) {
    console.error('Error updating user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500 }
    )
  }
}

// DELETE /api/users/[id] - Delete user
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  try {
    const { id } = await params
    // Get current user from auth
    const currentUser = authResult

    // Prevent deleting yourself
    if (currentUser.id === id) {
      return NextResponse.json(
        { error: 'Cannot delete your own account' },
        { status: 400 }
      )
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
      include: { appRole: { select: { isSystemAdmin: true } } },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Safeguard: prevent deleting the last system-admin user.
    if (user.appRole?.isSystemAdmin) {
      const systemAdminCount = await prisma.user.count({
        where: { appRole: { isSystemAdmin: true } },
      })
      if (systemAdminCount <= 1) {
        return NextResponse.json(
          { error: 'Cannot delete the last Admin user' },
          { status: 400 }
        )
      }
    }

    // Delete user
    await prisma.user.delete({
      where: { id },
    })

    logSecurityEvent({
      type: 'ADMIN_USER_DELETED',
      severity: 'WARNING',
      ipAddress: getClientIpAddress(request),
      details: {
        actorId: currentUser.id,
        actorEmail: currentUser.email,
        deletedUserId: user.id,
        deletedUserEmail: user.email,
      },
    }).catch(() => {})

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting user:', error)
    // SECURITY: Generic message
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500 }
    )
  }
}
