'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/admin/accounting', label: 'Dashboard', exact: true },
  { href: '/admin/accounting/bank-accounts', label: 'Bank Accounts', exact: false },
  { href: '/admin/accounting/expenses', label: 'Expenses', exact: false },
  { href: '/admin/accounting/chart-of-accounts', label: 'Chart of Accounts', exact: false },
  { href: '/admin/accounting/bas', label: 'BAS / GST', exact: false },
  { href: '/admin/accounting/reports', label: 'Reports', exact: false },
  { href: '/admin/accounting/settings', label: 'Settings', exact: false },
] as const

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="w-full max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="flex flex-col gap-3 sm:gap-4 mb-4 sm:mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Accounting</h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Under Development. Bank accounts, expenses, chart of accounts, BAS, and financial reports.
            </p>
          </div>

          <nav className="flex flex-wrap gap-2">
            {NAV.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname?.startsWith(item.href + '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    `px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ` +
                    (isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground')
                  }
                >
                  {item.label}
                </Link>
              )
            })}
          </nav>
        </div>

        {children}
      </div>
    </div>
  )
}
