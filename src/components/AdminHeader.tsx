'use client'

import { useAuth } from '@/components/AuthProvider'
import { Button } from '@/components/ui/button'
import { LogOut, User, Settings, Users, FolderKanban, Shield, Building2, DollarSign } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'

export default function AdminHeader() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [showSecurityDashboard, setShowSecurityDashboard] = useState(false)

  // Fetch security settings to check if security dashboard should be shown
  useEffect(() => {
    async function fetchSecuritySettings() {
      try {
      const response = await apiFetch('/api/settings')
        if (response.ok) {
          const data = await response.json()
          setShowSecurityDashboard(data.security?.viewSecurityEvents ?? false)
        }
      } catch (error) {
        // Security settings fetch failed - using defaults
      }
    }

    fetchSecuritySettings()
  }, [])

  if (!user) return null

  const permissions = user.permissions
    ? normalizeRolePermissions(user.permissions)
    : adminAllPermissions()

  const navLinks = [
    canSeeMenu(permissions, 'projects') ? { href: '/admin/projects', label: 'Projects', icon: FolderKanban } : null,
    canSeeMenu(permissions, 'clients') ? { href: '/admin/clients', label: 'Clients', icon: Building2 } : null,
    canSeeMenu(permissions, 'sales') ? { href: '/admin/sales', label: 'Sales', icon: DollarSign } : null,
    canSeeMenu(permissions, 'settings') ? { href: '/admin/settings', label: 'Settings', icon: Settings } : null,
    canSeeMenu(permissions, 'users') ? { href: '/admin/users', label: 'Users', icon: Users } : null,
  ].filter(Boolean) as Array<{ href: string; label: string; icon: any }>

  // Add Security link if enabled
  if (showSecurityDashboard && canSeeMenu(permissions, 'security')) {
    navLinks.push({ href: '/admin/security', label: 'Security', icon: Shield })
  }

  return (
    <div className="relative z-50 isolate transform-gpu bg-card border-b border-border/50 shadow-elevation-sm">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-6 flex-1 min-w-0">
            <nav className="flex gap-1 sm:gap-2 overflow-x-auto">
              {navLinks.map((link) => {
                const Icon = link.icon
                const isActive = pathname === link.href || (link.href !== '/admin/projects' && pathname?.startsWith(link.href))

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center gap-2 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-elevation'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    {Icon && <Icon className="w-4 h-4" />}
                    <span className="hidden sm:inline">{link.label}</span>
                  </Link>
                )
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden md:flex items-center gap-2 text-sm text-muted-foreground">
              <User className="w-4 h-4" />
              <span className="max-w-[150px] lg:max-w-none truncate">{user.email}</span>
            </div>
            <ThemeToggle />
            <Button
              variant="outline"
              size="default"
              onClick={logout}
              className="flex items-center justify-center gap-0 sm:gap-2 w-9 px-0 sm:w-auto sm:px-4"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Sign Out</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
