'use client'

import { useEffect, useMemo } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canSeeMenu, normalizeRolePermissions, type MenuKey } from '@/lib/rbac'

const PATH_MENU_MAP: Record<string, MenuKey> = {
  projects: 'projects',
  clients: 'clients',
  settings: 'settings',
  users: 'users',
  integrations: 'integrations',
  security: 'security',
  analytics: 'analytics',
}

export default function AdminMenuAccessGuard({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { user } = useAuth()

  const menuKey = useMemo(() => {
    if (!pathname?.startsWith('/admin')) return null
    const seg = pathname.split('/')[2] || ''
    if (!seg) return null // /admin index
    return PATH_MENU_MAP[seg] ?? null
  }, [pathname])

  const allowed = useMemo(() => {
    if (!menuKey) return true
    if (user?.isSystemAdmin) return true
    const permissions = normalizeRolePermissions(user?.permissions)
    return canSeeMenu(permissions, menuKey)
  }, [menuKey, user?.isSystemAdmin, user?.permissions])

  useEffect(() => {
    if (!allowed) {
      router.replace('/admin')
    }
  }, [allowed, router])

  if (!allowed) return null

  return children
}
