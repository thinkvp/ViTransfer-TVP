'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Read server-injected theme config from the inline script in layout.tsx */
function getThemeConfig(): { defaultTheme: string; allowToggle: boolean } {
  if (typeof window !== 'undefined' && (window as any).__THEME_CONFIG__) {
    return (window as any).__THEME_CONFIG__
  }
  return { defaultTheme: 'DARK', allowToggle: true }
}

function resolveDefault(defaultTheme: string): 'light' | 'dark' {
  if (defaultTheme === 'LIGHT') return 'light'
  if (defaultTheme === 'AUTO') {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark'
    return 'light'
  }
  return 'dark'
}

export default function ThemeToggle({
  buttonClassName,
  iconClassName,
}: {
  buttonClassName?: string
  iconClassName?: string
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [mounted, setMounted] = useState(false)
  const [allowed, setAllowed] = useState(true)

  useEffect(() => {
    setMounted(true)

    const config = getThemeConfig()
    setAllowed(config.allowToggle)

    if (!config.allowToggle) {
      // Theme toggle disabled — apply admin default and remove saved preference
      localStorage.removeItem('theme')
      const resolved = resolveDefault(config.defaultTheme)
      setTheme(resolved)
      if (resolved === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
      return
    }

    // Check if user has a saved preference, otherwise use admin default
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null

    if (savedTheme) {
      setTheme(savedTheme)
      if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    } else {
      const resolved = resolveDefault(config.defaultTheme)
      setTheme(resolved)
      if (resolved === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    // Save user's manual preference
    localStorage.setItem('theme', newTheme)

    // Apply/remove dark class properly
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  // Don't render if theme toggle is disabled
  if (!allowed) return null

  // Avoid hydration mismatch
  if (!mounted) {
    return (
      <Button
        type="button"
        variant="outline"
        size="icon"
        className={cn('p-2 rounded-lg', buttonClassName)}
        aria-label="Toggle theme"
        title="Toggle theme"
      >
        <div className={cn('h-5 w-5', iconClassName)} />
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={toggleTheme}
      className={cn('p-2 rounded-lg', buttonClassName)}
      aria-label="Toggle theme"
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? (
        <Moon className={cn('h-5 w-5 text-foreground', iconClassName)} />
      ) : (
        <Sun className={cn('h-5 w-5 text-foreground', iconClassName)} />
      )}
    </Button>
  )
}
