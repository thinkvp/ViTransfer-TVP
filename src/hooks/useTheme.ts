'use client'

import { useEffect, useState } from 'react'

/**
 * Reactive hook that tracks whether the app is in dark mode.
 * Observes the `dark` class on `<html>` via MutationObserver so it
 * stays in sync when the ThemeToggle (or anything else) flips theme.
 */
export function useTheme(): { theme: 'light' | 'dark'; isDark: boolean } {
  // Initial value: check the DOM class if available, else assume dark
  const [isDark, setIsDark] = useState(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return true // SSR fallback
  })

  useEffect(() => {
    const root = document.documentElement

    // Initial read
    setIsDark(root.classList.contains('dark'))

    // Watch for class changes on <html>
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'))
    })

    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  return { theme: isDark ? 'dark' : 'light', isDark }
}
