import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiAuth } from '@/lib/auth'
import { hashPassword, validatePassword } from '@/lib/encryption'
import { rateLimit } from '@/lib/rate-limit'
import { requireActionAccess, requireMenuAccess } from '@/lib/rbac-api'
import { normalizeHexDisplayColor } from '@/lib/display-color'
export const runtime = 'nodejs'



// Prevent static generation for this route
export const dynamic = 'force-dynamic'

// GET /api/users - List all users
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  // Rate limiting: 100 requests per minute for listing users
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Too many requests. Please slow down.'
  }, 'admin-users-list')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        displayColor: true,
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
      orderBy: {
        createdAt: 'desc',
      },
    })

    const response = NextResponse.json({ users })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json(
      { error: 'Unable to process request' },
      { status: 500 }
    )
  }
}

// POST /api/users - Create a new admin user
export async function POST(request: NextRequest) {
  const authResult = await requireApiAuth(request)
  if (authResult instanceof Response) return authResult

  const forbiddenMenu = requireMenuAccess(authResult, 'users')
  if (forbiddenMenu) return forbiddenMenu

  const forbiddenAction = requireActionAccess(authResult, 'manageUsers')
  if (forbiddenAction) return forbiddenAction

  // Rate limiting: 10 user creation requests per minute
  const rateLimitResult = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 10,
    message: 'Too many user creation requests. Please slow down.'
  }, 'admin-users-create')

  if (rateLimitResult) {
    return rateLimitResult
  }

  try {
    const body = await request.json()
    const { email, username, password, name, appRoleId, displayColor } = body

    // Validation
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    // Validate password strength
    const passwordValidation = validatePassword(password)
    if (!passwordValidation.isValid) {
      return NextResponse.json(
        { error: 'Password does not meet requirements', details: passwordValidation.errors },
        { status: 400 }
      )
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 409 }
      )
    }

    // Check if username already exists (if provided)
    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      })

      if (existingUsername) {
        return NextResponse.json(
          { error: 'Username already taken' },
          { status: 409 }
        )
      }
    }

    // Hash password
    const hashedPassword = await hashPassword(password)

    // Validate/resolve role
    const resolvedRoleId = typeof appRoleId === 'string' && appRoleId.trim() ? appRoleId.trim() : 'role_admin'
    const roleRecord = await prisma.role.findUnique({
      where: { id: resolvedRoleId },
      select: { id: true },
    })
    if (!roleRecord) {
      return NextResponse.json(
        { error: 'Invalid role' },
        { status: 400 }
      )
    }

    // Create user (always ADMIN role)
    let normalizedDisplayColor: string | null | undefined = undefined
    if (displayColor !== undefined) {
      if (displayColor === null || displayColor === '') {
        normalizedDisplayColor = null
      } else {
        const normalized = normalizeHexDisplayColor(displayColor)
        if (!normalized) {
          return NextResponse.json(
            { error: 'Invalid display colour. Use a hex value like #RRGGBB.' },
            { status: 400 }
          )
        }
        normalizedDisplayColor = normalized
      }
    }

    const user = await prisma.user.create({
      data: {
        email,
        username: username || null,
        password: hashedPassword,
        name: name || null,
        displayColor: normalizedDisplayColor,
        role: 'ADMIN',
        appRoleId: roleRecord.id,
      },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
        displayColor: true,
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

    const response = NextResponse.json({ user }, { status: 201 })
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    return response
  } catch (error) {
    return NextResponse.json(
      { error: 'Operation failed' },
      { status: 500 }
    )
  }
}
