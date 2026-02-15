'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getCurrencySymbol } from '@/lib/sales/currency'
import { fetchSalesSettings } from '@/lib/sales/admin-api'

const NAV = [
  { href: '/admin/sales', label: 'Dashboard' },
  { href: '/admin/sales/quotes', label: 'Quotes' },
  { href: '/admin/sales/invoices', label: 'Invoices' },
  { href: '/admin/sales/payments', label: 'Payments' },
  { href: '/admin/sales/settings', label: 'Settings' },
] as const

export default function SalesLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [currencySymbol, setCurrencySymbol] = useState('$')

  useEffect(() => {
    let cancelled = false
    fetchSalesSettings()
      .then((s) => { if (!cancelled) setCurrencySymbol(getCurrencySymbol(s.currencyCode)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex-1 min-h-0 bg-background">
      <div className="w-full max-w-screen-2xl mx-auto px-3 sm:px-4 lg:px-6 py-3 sm:py-6">
        <div className="flex flex-col gap-3 sm:gap-4 mb-4 sm:mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
              <span className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center">{currencySymbol}</span>
              Sales
            </h1>
            <p className="text-muted-foreground mt-1 text-sm sm:text-base">
              Quotes, invoices, payments, and sales settings.
            </p>
          </div>

          <nav className="flex flex-wrap gap-2">
            {NAV.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/admin/sales' && pathname?.startsWith(item.href))
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
