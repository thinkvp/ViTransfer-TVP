'use client'

import { useAuth } from '@/components/AuthProvider'
import { Button } from '@/components/ui/button'
import { LogOut, User, Settings, Users, FolderKanban, Shield, Building2, DollarSign, Menu } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import NotificationsBell from '@/components/NotificationsBell'
import RunningJobsBell from '@/components/RunningJobsBell'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

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
            {/* Mobile: hamburger menu for main nav */}
            <div className="md:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Main menu"
                    title="Main menu"
                    className="p-2 w-9 sm:w-10 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:border-primary/50"
                  >
                    <Menu className="h-4 w-4 sm:h-5 sm:w-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="bottom" sideOffset={8} onCloseAutoFocus={(e) => e.preventDefault()}>
                  {navLinks.map((link) => {
                    const Icon = link.icon
                    const isActive = pathname === link.href || (link.href !== '/admin/projects' && pathname?.startsWith(link.href))
                    return (
                      <DropdownMenuItem
                        key={link.href}
                        asChild
                        className={cn(
                          'cursor-pointer gap-2',
                          isActive && 'bg-accent text-accent-foreground'
                        )}
                      >
                        <Link href={link.href} className="flex items-center gap-2">
                          {Icon && <Icon className="w-4 h-4" />}
                          <span>{link.label}</span>
                        </Link>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Desktop: inline nav */}
            <nav className="hidden md:flex gap-1 sm:gap-2 overflow-x-auto">
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
            <ThemeToggle buttonClassName="w-9 sm:w-10" iconClassName="h-4 w-4 sm:h-5 sm:w-5" />
            <Button
              variant="outline"
              size="icon"
              onClick={logout}
              aria-label="Sign Out"
              title="Sign Out"
              className="p-2 w-9 sm:w-10"
            >
              <LogOut className="h-4 w-4 sm:h-5 sm:w-5" />
            </Button>
            <RunningJobsBell />
            <NotificationsBell />
          </div>
        </div>
      </div>
    </div>
  )
}
