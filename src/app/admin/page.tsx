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
        const sessionRes = await apiFetch('/api/auth/session')
        if (!sessionRes.ok) {
          router.replace('/login')
          return
        }

        const sessionData = await sessionRes.json()
        const permissions = sessionData?.user?.permissions
          ? normalizeRolePermissions(sessionData.user.permissions)
          : adminAllPermissions()

        // Security link also depends on server settings.
        let securityEnabled = false
        try {
          const settingsRes = await apiFetch('/api/settings')
          if (settingsRes.ok) {
            const settingsData = await settingsRes.json()
            securityEnabled = settingsData?.security?.viewSecurityEvents ?? false
          }
        } catch {
          // ignore
        }

        const candidates = [
          canSeeMenu(permissions, 'projects') ? '/admin/projects' : null,
          canSeeMenu(permissions, 'clients') ? '/admin/clients' : null,
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
