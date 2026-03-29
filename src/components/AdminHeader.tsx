'use client'

import { useAuth } from '@/components/AuthProvider'
import { Button } from '@/components/ui/button'
import { LogOut, User, Settings, Users, FolderKanban, Shield, Building2, DollarSign, Menu, ChevronDown, ChevronRight, LayoutDashboard, FileText, Receipt, CreditCard } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import NotificationsBell from '@/components/NotificationsBell'
import RunningJobsBell from '@/components/RunningJobsBell'
import ClientActivityEye from '@/components/ClientActivityEye'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { adminAllPermissions, canSeeMenu, normalizeRolePermissions } from '@/lib/rbac'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const SALES_SUBMENU = [
  { href: '/admin/sales', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/sales/quotes', label: 'Quotes', icon: FileText },
  { href: '/admin/sales/invoices', label: 'Invoices', icon: Receipt },
  { href: '/admin/sales/payments', label: 'Payments', icon: CreditCard },
  { href: '/admin/sales/settings', label: 'Settings', icon: Settings },
]

export default function AdminHeader() {
  const { user, logout } = useAuth()
  const pathname = usePathname()
  const [showSecurityDashboard, setShowSecurityDashboard] = useState(false)
  const [salesDropdownOpen, setSalesDropdownOpen] = useState(false)
  const [mobileSalesExpanded, setMobileSalesExpanded] = useState(false)
  const salesHoverRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const salesTriggerHoveredRef = useRef(false)
  const salesContentHoveredRef = useRef(false)

  const clearSalesCloseTimer = () => {
    if (salesHoverRef.current) {
      clearTimeout(salesHoverRef.current)
      salesHoverRef.current = null
    }
  }

  const openSalesDropdown = () => {
    clearSalesCloseTimer()
    setSalesDropdownOpen(true)
  }

  const scheduleSalesDropdownClose = () => {
    clearSalesCloseTimer()
    salesHoverRef.current = setTimeout(() => {
      if (!salesTriggerHoveredRef.current && !salesContentHoveredRef.current) {
        setSalesDropdownOpen(false)
      }
    }, 120)
  }

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

    return () => {
      clearSalesCloseTimer()
    }
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
    <div className="relative z-50 isolate transform-gpu bg-card border-b border-border/60 shadow-elevation-sm">
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
                    const isSales = link.href === '/admin/sales'

                    if (isSales) {
                      return (
                        <div key={link.href}>
                          <DropdownMenuItem
                            className={cn('cursor-pointer gap-2', isActive && 'bg-accent text-accent-foreground')}
                            onSelect={(e) => {
                              e.preventDefault()
                              setMobileSalesExpanded((v) => !v)
                            }}
                          >
                            {Icon && <Icon className="w-4 h-4" />}
                            <span className="flex-1">Sales</span>
                            {mobileSalesExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </DropdownMenuItem>
                          {mobileSalesExpanded && SALES_SUBMENU.map((sub) => {
                            const SubIcon = sub.icon
                            const subActive = pathname === sub.href || (sub.href !== '/admin/sales' && pathname?.startsWith(sub.href))
                            return (
                              <DropdownMenuItem
                                key={sub.href}
                                asChild
                                className={cn('cursor-pointer gap-2 pl-8', subActive && 'bg-accent text-accent-foreground')}
                              >
                                <Link href={sub.href} className="flex items-center gap-2">
                                  <SubIcon className="w-3.5 h-3.5" />
                                  <span>{sub.label}</span>
                                </Link>
                              </DropdownMenuItem>
                            )
                          })}
                        </div>
                      )
                    }

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
                const isSales = link.href === '/admin/sales'

                if (isSales) {
                  return (
                    <DropdownMenu
                      key={link.href}
                      modal={false}
                      open={salesDropdownOpen}
                      onOpenChange={(open) => {
                        if (open) {
                          openSalesDropdown()
                          return
                        }

                        if (salesTriggerHoveredRef.current || salesContentHoveredRef.current) {
                          return
                        }

                        setSalesDropdownOpen(false)
                      }}
                    >
                      <div
                        onMouseEnter={() => {
                          salesTriggerHoveredRef.current = true
                          openSalesDropdown()
                        }}
                        onMouseLeave={() => {
                          salesTriggerHoveredRef.current = false
                          scheduleSalesDropdownClose()
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={`flex items-center gap-2 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                              isActive
                                ? 'bg-primary text-primary-foreground shadow-elevation'
                                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                            }`}
                            aria-label="Sales menu"
                          >
                            {Icon && <Icon className="w-4 h-4" />}
                            <span className="hidden sm:inline">Sales</span>
                            <ChevronDown className="w-3 h-3 hidden sm:block" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="bottom"
                          sideOffset={8}
                          className="min-w-[180px]"
                          onPointerEnter={() => {
                            salesContentHoveredRef.current = true
                            clearSalesCloseTimer()
                          }}
                          onPointerLeave={() => {
                            salesContentHoveredRef.current = false
                            scheduleSalesDropdownClose()
                          }}
                          onEscapeKeyDown={() => {
                            salesTriggerHoveredRef.current = false
                            salesContentHoveredRef.current = false
                            clearSalesCloseTimer()
                            setSalesDropdownOpen(false)
                          }}
                          onInteractOutside={() => {
                            salesTriggerHoveredRef.current = false
                            salesContentHoveredRef.current = false
                            clearSalesCloseTimer()
                            setSalesDropdownOpen(false)
                          }}
                          onCloseAutoFocus={(e) => e.preventDefault()}
                        >
                          {SALES_SUBMENU.map((sub) => {
                            const SubIcon = sub.icon
                            const subActive = pathname === sub.href || (sub.href !== '/admin/sales' && pathname?.startsWith(sub.href))
                            return (
                              <DropdownMenuItem
                                key={sub.href}
                                asChild
                                className={cn('cursor-pointer gap-2.5', subActive && 'bg-accent text-accent-foreground font-medium')}
                              >
                                <Link href={sub.href} className="flex items-center gap-2.5">
                                  <SubIcon className="w-4 h-4 flex-shrink-0" />
                                  <span>{sub.label}</span>
                                </Link>
                              </DropdownMenuItem>
                            )
                          })}
                        </DropdownMenuContent>
                      </div>
                    </DropdownMenu>
                  )
                }

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
            <ClientActivityEye />
            <RunningJobsBell />
            <NotificationsBell />
          </div>
        </div>
      </div>
    </div>
  )
}
