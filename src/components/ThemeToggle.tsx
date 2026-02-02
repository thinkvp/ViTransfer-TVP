'use client'

import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export default function ThemeToggle({
  buttonClassName,
  iconClassName,
}: {
  buttonClassName?: string
  iconClassName?: string
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)

    // Check if user has a saved preference, otherwise default to dark
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null

    if (savedTheme) {
      // User has manually set a preference
      setTheme(savedTheme)
      if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    } else {
      // No saved preference: default to dark
      setTheme('dark')
      document.documentElement.classList.add('dark')
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
