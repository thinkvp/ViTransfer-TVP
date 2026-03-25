'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-client'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'

export default function AdminIndexPage() {
  const router = useRouter()

  useEffect(() => {
    const pickLandingPage = async () => {
      try {
        const [sessionRes, settingsRes] = await Promise.all([
          apiFetch('/api/auth/session'),
          apiFetch('/api/settings').catch(() => null),
        ])

        if (!sessionRes.ok) {
          router.replace('/login')
          return
        }

        const [sessionData, settingsData] = await Promise.all([
          sessionRes.json(),
          settingsRes?.ok ? settingsRes.json() : Promise.resolve(null),
        ])

        const permissions = sessionData?.user?.permissions
          ? normalizeRolePermissions(sessionData.user.permissions)
          : adminAllPermissions()

        const securityEnabled = settingsData?.security?.viewSecurityEvents ?? false

        const candidates = [
          canSeeMenu(permissions, 'projects') ? '/admin/projects' : null,
          canSeeMenu(permissions, 'clients') ? '/admin/clients' : null,
          canSeeMenu(permissions, 'sales') ? '/admin/sales' : null,
          canSeeMenu(permissions, 'settings') ? '/admin/settings' : null,
          canSeeMenu(permissions, 'users') ? '/admin/users' : null,
          securityEnabled && canSeeMenu(permissions, 'security') ? '/admin/security' : null,
        ].filter(Boolean) as string[]

        router.replace(candidates[0] || '/admin/projects')
      } catch {
        router.replace('/admin/projects')
      }
    }

    void pickLandingPage()
  }, [router])

  return null
}
