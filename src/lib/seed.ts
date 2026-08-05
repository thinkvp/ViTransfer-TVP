import type { Prisma } from '@prisma/client'
import { prisma } from './db'
import { hashPassword } from './encryption'
import { redactEmailForLogs } from './log-sanitization'
import { adminAllPermissions, normalizeRolePermissions } from './rbac'

/**
 * Ensure security settings are initialized
 */
async function ensureSecuritySettings() {
  try {
    await prisma.securitySettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        hotlinkProtection: 'LOG_ONLY',
        ipRateLimit: 1000, // High limit for video streaming with HTTP Range requests
        sessionRateLimit: 600, // 10 req/sec average for video buffering/seeking
        passwordAttempts: 5,
        trackAnalytics: true,
        trackSecurityLogs: true,
        viewSecurityEvents: false, // Hide security dashboard by default
      },
      update: {
        // Don't overwrite existing settings
      },
    })
  } catch (error) {
    console.error('Error initializing security settings:', error)
    // Don't throw - app should still start even if this fails
  }
}

/**
 * Ensure system admin roles carry the current full permission set.
 *
 * The Admin role is written once, at first boot, and the roles API refuses to edit
 * any system-admin role — so its stored JSON is frozen at whatever adminAllPermissions()
 * returned back then. Every menu/action/status added since is silently absent.
 *
 * Almost everything reads a system admin's permissions via fetchUserById(), which
 * substitutes adminAllPermissions() and masks the drift. Routes that authenticate by
 * standalone token (e.g. the key-dates ICS feed) read the stored record directly and
 * quietly lose access to anything the fossil is missing. Reconcile on every boot.
 */
async function ensureSystemAdminPermissions() {
  try {
    const desired = adminAllPermissions()

    const roles = await prisma.role.findMany({
      where: { isSystemAdmin: true },
      select: { id: true, name: true, permissions: true },
    })

    for (const role of roles) {
      const stored = normalizeRolePermissions(role.permissions)

      const missingStatuses = desired.projectVisibility.statuses.filter(
        (status) => !stored.projectVisibility.statuses.includes(status)
      )
      const missingMenus = Object.keys(desired.menuVisibility).filter(
        (menu) => stored.menuVisibility[menu as keyof typeof stored.menuVisibility] !== true
      )
      const missingActions = Object.keys(desired.actions).filter(
        (action) => stored.actions[action as keyof typeof stored.actions] !== true
      )

      if (!missingStatuses.length && !missingMenus.length && !missingActions.length) continue

      await prisma.role.update({
        where: { id: role.id },
        data: { permissions: desired as unknown as Prisma.InputJsonValue },
      })

      const repaired = [
        missingStatuses.length ? `statuses: ${missingStatuses.join(', ')}` : null,
        missingMenus.length ? `menus: ${missingMenus.join(', ')}` : null,
        missingActions.length ? `actions: ${missingActions.join(', ')}` : null,
      ].filter(Boolean)

      console.log(`Refreshed system admin role "${role.name}" (${repaired.join('; ')})`)
    }
  } catch (error) {
    console.error('Error ensuring system admin role permissions:', error)
    // Don't throw - app should still start even if this fails
  }
}

/**
 * Ensure default admin user exists
 * This is called automatically when the app starts
 *
 * SECURITY: Only creates default admin if NO admin users exist in the database
 * This prevents recreating default credentials on rebuilds (security risk)
 */
export async function ensureDefaultAdmin() {
  try {
    // Reconcile before the early return below — on an established install this is the
    // only branch that ever runs, and a fresh DB has no roles yet so it's a no-op.
    await ensureSystemAdminPermissions()

    // SECURITY: Check if ANY admin exists (not just the default one)
    // This prevents recreating default admin after it's been changed/removed
    const anyAdmin = await prisma.user.findFirst({
      where: {
        appRole: { isSystemAdmin: true }
      }
    })

    if (anyAdmin) {
      // Initialize security settings even if admin exists
      await ensureSecuritySettings()
      return
    }

    // No admin exists - require credentials from environment variables
    // SECURITY: No default credentials - must be set in .env file
    const adminEmail = process.env.ADMIN_EMAIL
    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminEmail || !adminPassword) {
      console.error('')
      console.error('===============================================================')
      console.error('CRITICAL ERROR: Admin credentials not configured!')
      console.error('===============================================================')
      console.error('')
      console.error('No admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set.')
      console.error('')
      console.error('REQUIRED: Set these environment variables in your .env file:')
      console.error('  ADMIN_EMAIL=your-admin@example.com')
      console.error('  ADMIN_PASSWORD=YourSecurePassword123')
      console.error('')
      console.error('Then restart the application.')
      console.error('')
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in environment variables for initial setup')
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(adminEmail)) {
      throw new Error(`Invalid ADMIN_EMAIL format: ${adminEmail}`)
    }

    // Validate password strength
    if (adminPassword.length < 8) {
      throw new Error('ADMIN_PASSWORD must be at least 8 characters long')
    }

    console.log('')
    console.log('===============================================================')
    console.log('Creating initial admin user...')
    console.log('===============================================================')
    console.log(`Email: ${redactEmailForLogs(adminEmail)}`)
    console.log('Password: ********')
    console.log('===============================================================')
    console.log('')

    const adminUsername = process.env.ADMIN_USERNAME || adminEmail.split('@')[0]
    const hashedPassword = await hashPassword(adminPassword)

      const roleDelegate = prisma.role
      const adminRole = await roleDelegate.findFirst({
        where: { isSystemAdmin: true },
        select: { id: true },
      }).catch(() => null)

      const adminRoleId = adminRole?.id
        ?? (await roleDelegate.create({
          data: {
            name: 'Admin',
            isSystemAdmin: true,
            permissions: adminAllPermissions() as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        }).catch(() => null))?.id

      if (!adminRoleId) {
        throw new Error('Unable to create Admin role')
      }

    await prisma.user.create({
      data: {
        username: adminUsername,
        email: adminEmail,
        password: hashedPassword,
        name: process.env.ADMIN_NAME || 'Admin',
          appRoleId: adminRoleId,
      },
    })

    console.log('Admin user created successfully!')
    console.log('')

    // Initialize security settings
    await ensureSecuritySettings()
  } catch (error) {
    console.error('Error ensuring default admin:', error)
    // Don't throw - app should still start even if this fails
  }
}
